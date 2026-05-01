import argparse
import json
import math
import os
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps

try:
    import onnxruntime as ort
except Exception:
    ort = None

try:
    import rawpy
except Exception:
    rawpy = None

RAW_EXTS = {".arw", ".cr2", ".cr3", ".nef", ".raf", ".dng", ".orf", ".rw2", ".pef", ".srw"}
OCEC_MODEL = Path(__file__).parent / "models" / "eye" / "ocec_s.onnx"
OPENVINO_EYE_MODEL = Path(__file__).parent / "models" / "eye" / "openvino" / "open_closed_eye.onnx"
YUNET_MODEL = Path(__file__).parent / "models" / "face" / "face_detection_yunet_2023mar.onnx"
SCRFD_MODEL = Path(__file__).parent / "models" / "face" / "insightface" / "scrfd_10g_bnkps.onnx"
LANDMARK106_MODEL = Path(__file__).parent / "models" / "face" / "insightface" / "2d106det.onnx"
YUNET_FALLBACK_MIN_SCORE = 0.72
_eye_session = None
_openvino_eye_session = None
_face_detector = None
_scrfd_session = None
_landmark106_session = None

LEFT_EYE_106 = [35, 36, 37, 39, 41, 42]
RIGHT_EYE_106 = [89, 90, 91, 93, 95, 96]


def clamp01(value):
    return max(0.0, min(1.0, float(value)))


def write_jpeg(image_rgb, output_path, max_side):
    h, w = image_rgb.shape[:2]
    scale = min(1.0, max_side / max(h, w))
    if scale < 1.0:
        image_rgb = cv2.resize(image_rgb, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(image_rgb).save(output_path, "JPEG", quality=88, optimize=True)


def decode_raw(input_path):
    if rawpy is None:
        raise RuntimeError("rawpy is not installed")
    with rawpy.imread(input_path) as raw:
        try:
            thumb = raw.extract_thumb()
            if thumb.format == rawpy.ThumbFormat.JPEG:
                data = np.frombuffer(thumb.data, dtype=np.uint8)
                bgr = cv2.imdecode(data, cv2.IMREAD_COLOR)
                if bgr is not None:
                    return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        except Exception:
            pass
        rgb = raw.postprocess(use_camera_wb=True, half_size=True, no_auto_bright=True, output_bps=8)
        return rgb


def decode_image(input_path):
    ext = Path(input_path).suffix.lower()
    if ext in RAW_EXTS:
        return decode_raw(input_path)
    pil = ImageOps.exif_transpose(Image.open(input_path)).convert("RGB")
    return np.array(pil)


def make_previews(args):
    image = decode_image(args.input)
    write_jpeg(image, args.preview, args.preview_side)
    write_jpeg(image, args.thumb, args.thumb_side)
    h, w = image.shape[:2]
    return {"ok": True, "width": w, "height": h}


def laplacian_sharpness(gray):
    variance = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    return clamp01(math.log1p(variance) / math.log1p(1200.0))


def exposure_score(gray):
    total = gray.size
    highlights = float(np.count_nonzero(gray >= 245)) / total
    shadows = float(np.count_nonzero(gray <= 10)) / total
    mean = float(gray.mean()) / 255.0
    mean_penalty = abs(mean - 0.5) * 0.55
    clip_penalty = min(0.75, highlights * 2.2 + shadows * 1.6)
    return clamp01(1.0 - mean_penalty - clip_penalty), highlights, shadows


def analyze_technical_quality(gray):
    sharp = laplacian_sharpness(gray)
    expo, highlights, shadows = exposure_score(gray)
    flags = []
    if sharp < 0.28:
        flags.append("possible_blur")
    if expo < 0.42:
        flags.append("bad_exposure")
    return sharp, expo, highlights, shadows, flags


def scrfd_session():
    global _scrfd_session
    if _scrfd_session is not None:
        return _scrfd_session
    if ort is None or not SCRFD_MODEL.exists():
        _scrfd_session = False
        return None
    _scrfd_session = ort.InferenceSession(str(SCRFD_MODEL), providers=["CPUExecutionProvider"])
    return _scrfd_session


def landmark106_session():
    global _landmark106_session
    if _landmark106_session is not None:
        return _landmark106_session
    if ort is None or not LANDMARK106_MODEL.exists():
        _landmark106_session = False
        return None
    _landmark106_session = ort.InferenceSession(str(LANDMARK106_MODEL), providers=["CPUExecutionProvider"])
    return _landmark106_session


def yunet_detector(width, height):
    global _face_detector
    if not YUNET_MODEL.exists() or not hasattr(cv2, "FaceDetectorYN_create"):
        return None
    if _face_detector is None:
        _face_detector = cv2.FaceDetectorYN_create(str(YUNET_MODEL), "", (width, height), 0.55, 0.3, 5000)
    _face_detector.setInputSize((width, height))
    return _face_detector


def distance2bbox(points, distance):
    x1 = points[:, 0] - distance[:, 0]
    y1 = points[:, 1] - distance[:, 1]
    x2 = points[:, 0] + distance[:, 2]
    y2 = points[:, 1] + distance[:, 3]
    return np.stack([x1, y1, x2, y2], axis=-1)


def distance2kps(points, distance):
    preds = []
    for i in range(0, distance.shape[1], 2):
        px = points[:, 0] + distance[:, i]
        py = points[:, 1] + distance[:, i + 1]
        preds.append(px)
        preds.append(py)
    return np.stack(preds, axis=-1)


def nms(dets, thresh=0.4):
    if len(dets) == 0:
        return []
    x1, y1, x2, y2, scores = dets[:, 0], dets[:, 1], dets[:, 2], dets[:, 3], dets[:, 4]
    areas = (x2 - x1 + 1) * (y2 - y1 + 1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        w = np.maximum(0.0, xx2 - xx1 + 1)
        h = np.maximum(0.0, yy2 - yy1 + 1)
        inter = w * h
        ovr = inter / (areas[i] + areas[order[1:]] - inter)
        inds = np.where(ovr <= thresh)[0]
        order = order[inds + 1]
    return keep


def detect_faces_scrfd(image_rgb):
    session = scrfd_session()
    if session is None:
        return []
    h_img, w_img = image_rgb.shape[:2]
    input_w = 640
    input_h = 640
    scale = min(input_w / w_img, input_h / h_img)
    resized_w = int(round(w_img * scale))
    resized_h = int(round(h_img * scale))
    resized = cv2.resize(image_rgb, (resized_w, resized_h), interpolation=cv2.INTER_AREA)
    canvas = np.zeros((input_h, input_w, 3), dtype=np.uint8)
    canvas[:resized_h, :resized_w] = resized
    blob = ((canvas.astype(np.float32) - 127.5) / 128.0).transpose(2, 0, 1)[None, :, :, :]
    try:
        outputs = session.run(None, {session.get_inputs()[0].name: blob})
    except Exception:
        return []

    scores_list = outputs[0:3]
    bbox_list = outputs[3:6]
    kps_list = outputs[6:9]
    strides = [8, 16, 32]
    all_boxes = []
    all_kps = []
    all_scores = []
    for stride, scores, bbox_preds, kps_preds in zip(strides, scores_list, bbox_list, kps_list):
        height = input_h // stride
        width = input_w // stride
        anchor_centers = np.stack(np.mgrid[:height, :width][::-1], axis=-1).astype(np.float32)
        anchor_centers = (anchor_centers * stride).reshape((-1, 2))
        anchor_centers = np.repeat(anchor_centers, 2, axis=0)
        scores = scores.reshape(-1)
        bbox_preds = bbox_preds.reshape((-1, 4)) * stride
        kps_preds = kps_preds.reshape((-1, 10)) * stride
        pos = np.where(scores >= 0.42)[0]
        if len(pos) == 0:
            continue
        boxes = distance2bbox(anchor_centers[pos], bbox_preds[pos])
        kps = distance2kps(anchor_centers[pos], kps_preds[pos]).reshape((-1, 5, 2))
        all_boxes.append(boxes)
        all_kps.append(kps)
        all_scores.append(scores[pos])
    if not all_boxes:
        return []

    boxes = np.vstack(all_boxes)
    kps = np.vstack(all_kps)
    scores = np.concatenate(all_scores)
    boxes[:, [0, 2]] = np.clip(boxes[:, [0, 2]], 0, resized_w) / scale
    boxes[:, [1, 3]] = np.clip(boxes[:, [1, 3]], 0, resized_h) / scale
    kps[:, :, 0] = np.clip(kps[:, :, 0], 0, resized_w) / scale
    kps[:, :, 1] = np.clip(kps[:, :, 1], 0, resized_h) / scale
    dets = np.hstack([boxes, scores[:, None]])
    keep = nms(dets, 0.4)[:8]
    faces = []
    for i in keep:
        x1, y1, x2, y2 = boxes[i]
        w = x2 - x1
        h = y2 - y1
        if w < 24 or h < 24:
            continue
        points = kps[i]
        landmarks = {
            "right_eye": (float(points[0][0]), float(points[0][1])),
            "left_eye": (float(points[1][0]), float(points[1][1])),
            "nose": (float(points[2][0]), float(points[2][1])),
            "mouth_right": (float(points[3][0]), float(points[3][1])),
            "mouth_left": (float(points[4][0]), float(points[4][1])),
        }
        faces.append({
            "box": (max(0, int(round(x1))), max(0, int(round(y1))), int(round(w)), int(round(h))),
            "landmarks": landmarks,
            "score": float(scores[i]),
            "source": "scrfd",
        })
    return sorted(faces, key=lambda face: face["box"][2] * face["box"][3] * (face["score"] ** 3), reverse=True)


def add_landmark106(image_rgb, faces):
    session = landmark106_session()
    if session is None:
        return faces
    h_img, w_img = image_rgb.shape[:2]
    for face in faces[:3]:
        x, y, w, h = face["box"]
        cx = x + w / 2
        cy = y + h / 2
        size = max(w, h) * 1.35
        x0 = max(0, int(round(cx - size / 2)))
        y0 = max(0, int(round(cy - size / 2)))
        x1 = min(w_img, int(round(cx + size / 2)))
        y1 = min(h_img, int(round(cy + size / 2)))
        crop = image_rgb[y0:y1, x0:x1]
        if crop.size == 0:
            continue
        resized = cv2.resize(crop, (192, 192), interpolation=cv2.INTER_AREA)
        blob = (resized.astype(np.float32) / 255.0).transpose(2, 0, 1)[None, :, :, :]
        try:
            pred = session.run(None, {session.get_inputs()[0].name: blob})[0].reshape((-1, 2))
        except Exception:
            continue
        pts = (pred + 1.0) * 96.0
        pts[:, 0] = x0 + pts[:, 0] / 192.0 * max(1, x1 - x0)
        pts[:, 1] = y0 + pts[:, 1] / 192.0 * max(1, y1 - y0)
        face["landmark106"] = pts.astype(float).tolist()
    return faces


def detect_faces(image_rgb, gray):
    scrfd_faces = detect_faces_scrfd(image_rgb)
    if scrfd_faces:
        return add_landmark106(image_rgb, scrfd_faces)

    h_img, w_img = gray.shape[:2]
    detector = yunet_detector(w_img, h_img)
    if detector is not None:
        try:
            _, detections = detector.detect(cv2.cvtColor(image_rgb, cv2.COLOR_RGB2BGR))
            if detections is not None and len(detections):
                faces = []
                for det in detections:
                    x, y, w, h = [float(v) for v in det[:4]]
                    score = float(det[14]) if len(det) > 14 else 1.0
                    if score < YUNET_FALLBACK_MIN_SCORE:
                        continue
                    if w < 28 or h < 28:
                        continue
                    landmarks = {
                        "right_eye": (float(det[4]), float(det[5])),
                        "left_eye": (float(det[6]), float(det[7])),
                        "nose": (float(det[8]), float(det[9])),
                        "mouth_right": (float(det[10]), float(det[11])),
                        "mouth_left": (float(det[12]), float(det[13])),
                    }
                    faces.append({
                        "box": (
                            max(0, int(round(x))),
                            max(0, int(round(y))),
                            int(round(min(w, w_img - max(0, x)))),
                            int(round(min(h, h_img - max(0, y)))),
                        ),
                        "landmarks": landmarks,
                        "score": score,
                        "source": "yunet",
                    })
                if faces:
                    return sorted(faces, key=lambda face: face["box"][2] * face["box"][3] * (face["score"] ** 3), reverse=True)
        except Exception:
            pass

    if SCRFD_MODEL.exists() or YUNET_MODEL.exists():
        return []

    face_path = os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")
    face_cascade = cv2.CascadeClassifier(face_path)
    faces = face_cascade.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=5, minSize=(42, 42))
    return [{"box": (int(x), int(y), int(w), int(h)), "landmarks": None, "score": 0.35, "source": "haar"} for (x, y, w, h) in faces]


def analyze_face_visibility(gray, faces):
    if len(faces) == 0:
        return {"face_score": 0.35, "face_count": 0, "face_visibility": "not_visible", "flags": ["face_missing"], "faces": [], "detector": "none"}

    h_img, w_img = gray.shape[:2]
    face_scores = []
    flags = []
    normalized_faces = []
    partial = False
    detectors = set()
    for face in faces:
        x, y, w, h = face["box"]
        detectors.add(face.get("source", "unknown"))
        roi = gray[y : y + h, x : x + w]
        face_sharp = laplacian_sharpness(roi) if roi.size else 0.3
        face_scores.append(face_sharp)
        normalized_faces.append(face)
        margin = max(2, int(min(w, h) * 0.04))
        if x <= margin or y <= margin or x + w >= w_img - margin or y + h >= h_img - margin:
            partial = True
        if face_sharp < 0.35:
            flags.append("face_blur")

    return {
        "face_score": clamp01(float(np.mean(face_scores)) if face_scores else 0.5),
        "face_count": len(faces),
        "face_visibility": "partial" if partial else "visible",
        "flags": sorted(set(flags)),
        "faces": normalized_faces,
        "detector": "yunet" if "yunet" in detectors else next(iter(detectors), "unknown"),
    }


def eye_model_session():
    global _eye_session
    if _eye_session is not None:
        return _eye_session
    if ort is None or not OCEC_MODEL.exists():
        _eye_session = False
        return None
    _eye_session = ort.InferenceSession(str(OCEC_MODEL), providers=["CPUExecutionProvider"])
    return _eye_session


def openvino_eye_model_session():
    global _openvino_eye_session
    if _openvino_eye_session is not None:
        return _openvino_eye_session
    if ort is None or not OPENVINO_EYE_MODEL.exists():
        _openvino_eye_session = False
        return None
    _openvino_eye_session = ort.InferenceSession(str(OPENVINO_EYE_MODEL), providers=["CPUExecutionProvider"])
    return _openvino_eye_session


def preprocess_eye(crop, session):
    input_meta = session.get_inputs()[0]
    shape = input_meta.shape
    height = 24
    width = 40
    if len(shape) == 4:
        if shape[1] in (1, 3):
            height = int(shape[2] or height)
            width = int(shape[3] or width)
        else:
            height = int(shape[1] or height)
            width = int(shape[2] or width)
    interpolation = cv2.INTER_CUBIC if crop.shape[0] < height or crop.shape[1] < width else cv2.INTER_AREA
    resized = cv2.resize(crop, (width, height), interpolation=interpolation)
    normalized = resized.astype(np.float32) / 255.0
    if len(shape) == 4 and shape[1] in (1, 3):
        if shape[1] == 3:
            normalized = np.stack([normalized, normalized, normalized], axis=0)
        else:
            normalized = normalized[None, :, :]
        return normalized[None, :, :, :]
    if len(shape) == 4:
        return normalized[None, :, :, None]
    return normalized.reshape(1, -1)


def preprocess_openvino_eye(crop):
    resized = cv2.resize(crop, (32, 32), interpolation=cv2.INTER_CUBIC)
    if resized.ndim == 2:
        bgr = cv2.cvtColor(resized, cv2.COLOR_GRAY2BGR)
    else:
        bgr = cv2.cvtColor(resized, cv2.COLOR_RGB2BGR)
    arr = (bgr.astype(np.float32) / 255.0).transpose(2, 0, 1)[None, :, :, :]
    return arr


def sigmoid(value):
    return 1.0 / (1.0 + math.exp(-float(value)))


def infer_eye_state_openvino(crop):
    session = openvino_eye_model_session()
    if session is None:
        return None
    try:
        input_name = session.get_inputs()[0].name
        output = session.run(None, {input_name: preprocess_openvino_eye(crop)})[0]
        values = np.asarray(output).reshape(-1).astype(float)
        if values.size < 2:
            return None
        if not np.all(np.isfinite(values)):
            return None
        if abs(float(np.sum(values)) - 1.0) < 0.05 and np.all(values >= 0):
            probs = values
        else:
            shifted = values - np.max(values)
            probs = np.exp(shifted) / np.sum(np.exp(shifted))
        prob_open = float(probs[0])
        prob_closed = float(probs[1])
        if prob_open >= 0.72 and prob_open >= prob_closed:
            return "open", prob_open
        if prob_closed >= 0.92 and prob_closed > prob_open:
            return "closed", prob_closed
        return "uncertain", max(prob_open, prob_closed)
    except Exception:
        return None


def infer_eye_state_ocec(crop):
    session = eye_model_session()
    if session is None:
        return "uncertain", 0.0
    try:
        input_name = session.get_inputs()[0].name
        output = session.run(None, {input_name: preprocess_eye(crop, session)})[0]
        values = np.asarray(output).reshape(-1).astype(float)
        if values.size >= 2:
            shifted = values - np.max(values)
            probs = np.exp(shifted) / np.sum(np.exp(shifted))
            prob_open = float(probs[-1])
        else:
            raw = float(values[0])
            prob_open = raw if 0.0 <= raw <= 1.0 else sigmoid(raw)
    except Exception:
        return "uncertain", 0.0

    if prob_open >= 0.85:
        return "open", prob_open
    if prob_open <= 0.15:
        return "closed", 1.0 - prob_open
    return "uncertain", max(prob_open, 1.0 - prob_open)


def infer_eye_state(crop):
    # The OpenVINO open-closed-eye model is kept for experiments, but its MRL
    # training domain over-fires on outdoor portrait crops. Use OCEC as the
    # default classifier until a stronger landmark/eye model is calibrated.
    return infer_eye_state_ocec(crop)


def crop_eye_from_landmark(gray, center, face_box, width_scale=0.28, height_scale=0.18):
    x, y, w, h = face_box
    cx, cy = center
    box_w = max(18, int(w * width_scale))
    box_h = max(12, int(h * height_scale))
    x0 = max(0, int(round(cx - box_w / 2)))
    x1 = min(gray.shape[1], int(round(cx + box_w / 2)))
    y0 = max(0, int(round(cy - box_h / 2)))
    y1 = min(gray.shape[0], int(round(cy + box_h / 2)))
    crop = gray[y0:y1, x0:x1]
    return {"crop": crop, "box": (x0, y0, x1 - x0, y1 - y0)} if crop.size else None


def landmark_eye_crop_variants(gray, center, face_box):
    variants = []
    # OCEC is sensitive to overly tight crops on smiling/squinting eyes. Run a
    # small multi-scale set so closed requires stable evidence, not one thin line.
    for width_scale, height_scale in ((0.28, 0.18), (0.42, 0.20), (0.55, 0.20), (0.65, 0.20)):
        crop = crop_eye_from_landmark(gray, center, face_box, width_scale, height_scale)
        if crop is not None:
            variants.append(crop)
    return variants


def detect_eye_crops(gray, faces):
    for face in faces:
        if face.get("source") in ("scrfd", "yunet") and face.get("landmarks"):
            landmarks = face["landmarks"]
            crops = {}
            left_variants = landmark_eye_crop_variants(gray, landmarks["left_eye"], face["box"])
            right_variants = landmark_eye_crop_variants(gray, landmarks["right_eye"], face["box"])
            if left_variants:
                debug_crop = left_variants[-1]
                crops["left"] = {"crop": debug_crop["crop"], "box": debug_crop["box"], "source": "landmark", "variants": left_variants}
            if right_variants:
                debug_crop = right_variants[-1]
                crops["right"] = {"crop": debug_crop["crop"], "box": debug_crop["box"], "source": "landmark", "variants": right_variants}
            if crops:
                return crops

    # Haar fallback is only a localization fallback. It may enter review, but it
    # should not create a confident open/closed decision.
    if not faces or faces[0].get("source") == "haar":
        return {}

    eye_path = os.path.join(cv2.data.haarcascades, "haarcascade_eye_tree_eyeglasses.xml")
    eye_cascade = cv2.CascadeClassifier(eye_path)
    for face in faces:
        x, y, w, h = face["box"]
        roi = gray[y : y + h, x : x + w]
        upper = roi[: max(1, int(h * 0.62)), :]
        eyes_found = eye_cascade.detectMultiScale(upper, scaleFactor=1.08, minNeighbors=4, minSize=(12, 8))
        candidates = []
        for (ex, ey, ew, eh) in eyes_found:
            cx = x + ex + ew / 2
            side = "left" if cx < x + w / 2 else "right"
            pad_x = int(ew * 0.32)
            pad_y = int(eh * 0.55)
            x0 = max(0, x + ex - pad_x)
            y0 = max(0, y + ey - pad_y)
            x1 = min(gray.shape[1], x + ex + ew + pad_x)
            y1 = min(gray.shape[0], y + ey + eh + pad_y)
            area = ew * eh
            candidates.append((side, area, gray[y0:y1, x0:x1], (x0, y0, x1 - x0, y1 - y0)))
        if candidates:
            eyes = {}
            for side in ("left", "right"):
                side_candidates = [item for item in candidates if item[0] == side and item[2].size]
                if side_candidates:
                    best = max(side_candidates, key=lambda item: item[1])
                    eyes[side] = {"crop": best[2], "box": best[3]}
            if "left" in eyes and "right" in eyes:
                return {side: {"crop": item["crop"], "box": item["box"], "source": "detected"} for side, item in eyes.items()}
            missing = [side for side in ("left", "right") if side not in eyes]
            eyes.update(approximate_eye_crops(gray, x, y, w, h, missing))
            if eyes:
                return {
                    side: {"crop": item["crop"], "box": item["box"], "source": "detected" if side not in missing else "estimated"}
                    for side, item in eyes.items()
                }
        approximate = approximate_eye_crops(gray, x, y, w, h)
        if approximate:
            return {side: {"crop": item["crop"], "box": item["box"], "source": "estimated"} for side, item in approximate.items()}
    return {}


def approximate_eye_crops(gray, x, y, w, h, sides=None):
    requested = sides or ["left", "right"]
    crops = {}
    eye_y0 = y + int(h * 0.24)
    eye_y1 = y + int(h * 0.52)
    regions = {
        "left": (x + int(w * 0.13), x + int(w * 0.50)),
        "right": (x + int(w * 0.50), x + int(w * 0.87)),
    }
    for side in requested:
        x0, x1 = regions[side]
        x0 = max(0, x0)
        x1 = min(gray.shape[1], x1)
        y0 = max(0, eye_y0)
        y1 = min(gray.shape[0], eye_y1)
        crop = gray[y0:y1, x0:x1]
        if crop.size:
            crops[side] = {"crop": crop, "box": (x0, y0, x1 - x0, y1 - y0)}
    return crops


def merge_eye_states(left, right):
    left_state, left_conf, left_source, left_size = left
    right_state, right_conf, right_source, right_size = right
    available = [item for item in (left, right) if item[0] != "missing"]
    if not available:
        return "not_applicable", 0.0, 0.0
    if len(available) < 2:
        return "uncertain", max(conf for _, conf, _, _ in available), 0.5
    if left_state == "open" and right_state == "open" and left_conf >= 0.85 and right_conf >= 0.85:
        return "open", min(left_conf, right_conf), 1.0
    if (
        (left_state == "open" and left_conf >= 0.85 and right_state != "closed")
        or (right_state == "open" and right_conf >= 0.85 and left_state != "closed")
    ):
        return "open", max(left_conf if left_state == "open" else 0.0, right_conf if right_state == "open" else 0.0), 0.9
    if (
        left_state == "closed"
        and right_state == "closed"
        and left_conf >= 0.93
        and right_conf >= 0.93
        and left_source in ("detected", "landmark")
        and right_source in ("detected", "landmark")
        and min(left_size[0], right_size[0]) >= 26
        and min(left_size[1], right_size[1]) >= 16
    ):
        return "closed", min(left_conf, right_conf), 0.0
    return "uncertain", max(left_conf, right_conf), 0.5


def infer_eye_state_from_crop_info(crop_info):
    variants = crop_info.get("variants")
    if not variants:
        return infer_eye_state(crop_info["crop"])

    results = [infer_eye_state(item["crop"]) for item in variants if item.get("crop") is not None and item["crop"].size]
    if not results:
        return "uncertain", 0.0

    strong_open = [conf for state, conf in results if state == "open" and conf >= 0.85]
    strong_closed = [conf for state, conf in results if state == "closed" and conf >= 0.93]
    best_conf = max(conf for _, conf in results)

    if strong_open and strong_closed:
        return "uncertain", best_conf
    if len(strong_open) >= 2 or (strong_open and not strong_closed):
        return "open", max(strong_open)
    if len(strong_closed) >= 2 and not strong_open:
        return "closed", min(strong_closed)
    return "uncertain", best_conf


def analyze_eye_state(gray, face_visibility, crops=None):
    if face_visibility["face_count"] == 0 or face_visibility["face_visibility"] in ("not_visible", "back"):
        return {
            "eye_state": "not_applicable",
            "eye_confidence": 0.0,
            "left_eye_state": "missing",
            "right_eye_state": "missing",
            "eyes_open_score": 0.0,
            "flags": [],
        }

    crops = crops if crops is not None else detect_eye_crops(gray, face_visibility["faces"])
    left = (
        *infer_eye_state_from_crop_info(crops["left"]),
        crops["left"]["source"],
        (crops["left"]["box"][2], crops["left"]["box"][3]),
    ) if "left" in crops else ("missing", 0.0, "missing", (0, 0))
    right = (
        *infer_eye_state_from_crop_info(crops["right"]),
        crops["right"]["source"],
        (crops["right"]["box"][2], crops["right"]["box"][3]),
    ) if "right" in crops else ("missing", 0.0, "missing", (0, 0))
    eye_state, confidence, eyes_open_score = merge_eye_states(left, right)
    flags = []
    if eye_state == "closed":
        flags.append("closed_eyes")
    elif eye_state == "uncertain":
        flags.append("eyes_uncertain")
    return {
        "eye_state": eye_state,
        "eye_confidence": confidence,
        "left_eye_state": left[0],
        "right_eye_state": right[0],
        "eyes_open_score": eyes_open_score,
        "flags": flags,
    }


def analyze_subject_quality(image_rgb, gray, face_count):
    h, w = gray.shape[:2]
    hsv = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2HSV)
    saturation = hsv[:, :, 1] / 255.0
    value = hsv[:, :, 2] / 255.0
    strong_color = (saturation > 0.42) & (value > 0.18)

    border = max(8, int(min(h, w) * 0.08))
    border_mask = np.zeros_like(gray, dtype=bool)
    border_mask[:border, :] = True
    border_mask[-border:, :] = True
    border_mask[:, :border] = True
    border_mask[:, -border:] = True

    color_ratio = float(np.count_nonzero(strong_color)) / strong_color.size
    border_color_ratio = float(np.count_nonzero(strong_color & border_mask)) / max(1, np.count_nonzero(border_mask))

    center = gray[int(h * 0.18) : int(h * 0.82), int(w * 0.18) : int(w * 0.82)]
    center_sharp = laplacian_sharpness(center) if center.size else 0.0

    flags = []
    score = 1.0
    if face_count == 0:
        score -= 0.08
    if border_color_ratio > 0.34 and color_ratio > 0.22:
        flags.append("subject_cropped")
        score -= 0.42
    if center_sharp < 0.24 and face_count == 0:
        flags.append("weak_subject")
        score -= 0.2

    return clamp01(score), flags


def merge_analysis_flags(*flag_groups):
    flags = []
    for group in flag_groups:
        flags.extend(group)
    return sorted(set(flags))


def normalize_box(box, width, height):
    x, y, w, h = box
    return [clamp01(x / width), clamp01(y / height), clamp01(w / width), clamp01(h / height)]


def normalize_point(point, width, height):
    x, y = point
    return [clamp01(x / width), clamp01(y / height)]


def build_debug_regions(faces, eye_crops, image_width, image_height):
    source_labels = {
        "scrfd": "SCRFD",
        "yunet": "YuNet",
        "haar": "Haar",
        "landmark": "关键点",
        "detected": "检测",
        "estimated": "估算",
        "unknown": "未知",
    }
    landmark_labels = {
        "right_eye": "右眼",
        "left_eye": "左眼",
        "nose": "鼻尖",
        "mouth_right": "右嘴角",
        "mouth_left": "左嘴角",
    }
    side_labels = {
        "left": "左眼",
        "right": "右眼",
    }
    regions = []
    for index, face in enumerate(faces):
        source = face.get("source", "unknown")
        score = face.get("score", 0.0)
        regions.append({
            "kind": "face",
            "label": f"人脸 {source_labels.get(source, source)} {score:.2f}",
            "box": normalize_box(face["box"], image_width, image_height),
            "source": source,
            "score": score,
        })
        for name, point in (face.get("landmarks") or {}).items():
            regions.append({
                "kind": "landmark",
                "label": landmark_labels.get(name, name),
                "point": normalize_point(point, image_width, image_height),
                "source": source,
            })
        if index > 4:
            break
    for side, crop in eye_crops.items():
        source = crop.get("source", "unknown")
        regions.append({
            "kind": "eye",
            "label": f"{side_labels.get(side, side)}裁剪 {source_labels.get(source, source)}",
            "box": normalize_box(crop["box"], image_width, image_height),
            "source": source,
        })
    return regions


def analyze(args):
    image = decode_image(args.input)
    max_side = 4096
    h, w = image.shape[:2]
    scale = min(1.0, max_side / max(h, w))
    if scale < 1.0:
        image = cv2.resize(image, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)

    sharp, expo, highlights, shadows, technical_flags = analyze_technical_quality(gray)
    faces = detect_faces(image, gray)
    face = analyze_face_visibility(gray, faces)
    eye_crops = detect_eye_crops(gray, face["faces"]) if face["face_count"] else {}
    eye = analyze_eye_state(gray, face, eye_crops)
    subject_score, subject_flags = analyze_subject_quality(image, gray, face["face_count"])

    flags = merge_analysis_flags(technical_flags, face["flags"], eye["flags"], subject_flags)

    final = clamp01(0.3 * sharp + 0.22 * expo + 0.18 * face["face_score"] + 0.12 * eye["eyes_open_score"] + 0.18 * subject_score)
    return {
        "sharpnessScore": sharp,
        "exposureScore": expo,
        "highlightClipRatio": highlights,
        "shadowClipRatio": shadows,
        "faceScore": face["face_score"],
        "eyesOpenScore": eye["eyes_open_score"],
        "faceVisibility": face["face_visibility"],
        "eyeState": eye["eye_state"],
        "eyeConfidence": eye["eye_confidence"],
        "leftEyeState": eye["left_eye_state"],
        "rightEyeState": eye["right_eye_state"],
        "debugRegions": build_debug_regions(face["faces"], eye_crops, image.shape[1], image.shape[0]),
        "faceCount": face["face_count"],
        "finalScore": final,
        "riskFlags": flags,
    }


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("preview")
    p.add_argument("--input", required=True)
    p.add_argument("--preview", required=True)
    p.add_argument("--thumb", required=True)
    p.add_argument("--preview-side", type=int, default=1800)
    p.add_argument("--thumb-side", type=int, default=360)

    a = sub.add_parser("analyze")
    a.add_argument("--input", required=True)

    args = parser.parse_args()
    try:
        if args.command == "preview":
            result = make_previews(args)
        else:
            result = analyze(args)
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
