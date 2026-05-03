---
title: SenseFrame GitHub CI/CD 自动打包发布方案
date: 2026-05-03
tags:
  - project/AI选片
  - product/SenseFrame
  - cicd
  - electron
aliases:
  - SenseFrame 自动打包发布
  - SenseFrame GitHub Actions 打包方案
  - SenseFrame Electron CI/CD
---

# SenseFrame GitHub CI/CD 自动打包发布方案

> [!summary]
> SenseFrame 要接 GitHub CI/CD，推荐使用 GitHub Actions + electron-builder。第一阶段目标是 tag 触发后自动构建 macOS 和 Windows 安装包，并上传到 GitHub Release draft；签名、公证、自动更新可以后续分阶段接入。

## 目标

我们要实现：

```text
push tag v0.1.1
  -> GitHub Actions 自动跑 typecheck/build
  -> macOS runner 生成 dmg/zip
  -> Windows runner 生成 exe/nsis
  -> 上传到 GitHub Releases draft
  -> 人工检查后发布
```

第一版不做：

- 自动发布正式 release。
- 自动更新。
- macOS Developer ID 签名和公证。
- Windows 代码签名。
- Python worker 完整内置运行时。

这些放到第二阶段。

## 推荐技术栈

### 打包工具：electron-builder

原因：

- 适合现有 `electron-vite` 项目。
- 支持 GitHub Releases 发布。
- 支持 macOS `dmg` / `zip`。
- 支持 Windows `nsis` 安装包。
- 支持 native dependencies rebuild。
- 支持后续代码签名、公证、自动更新。

不建议第一版用 Electron Forge 迁移，因为项目现在不是 Forge 结构，接 `electron-builder` 改动更小。

### CI 平台：GitHub Actions

runner：

- `macos-latest`：构建 macOS 安装包。
- `windows-latest`：构建 Windows 安装包。

不建议用单一 runner 交叉构建全部平台，尤其项目有 `better-sqlite3`、`sharp` 这类 native 依赖。

## 当前项目构建状态

当前 `package.json`：

```json
{
  "scripts": {
    "build": "tsc --noEmit && electron-vite build",
    "typecheck": "tsc --noEmit"
  }
}
```

现在只有编译，没有安装包产物。

需要新增：

```json
{
  "scripts": {
    "dist": "pnpm run build && electron-builder",
    "dist:mac": "pnpm run build && electron-builder --mac",
    "dist:win": "pnpm run build && electron-builder --win"
  },
  "devDependencies": {
    "electron-builder": "latest"
  }
}
```

## GitHub Actions 工作流

建议新增：

```text
.github/workflows/release.yml
```

触发方式：

- tag：`v*.*.*`
- 手动：`workflow_dispatch`

```yaml
name: Release Desktop Apps

on:
  push:
    tags:
      - "v*.*.*"
  workflow_dispatch:

permissions:
  contents: write

jobs:
  release:
    name: Build ${{ matrix.platform }}
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: mac
            os: macos-latest
            command: pnpm run dist:mac
          - platform: win
            os: windows-latest
            command: pnpm run dist:win

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 10

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Typecheck
        run: pnpm run typecheck

      - name: Build package
        run: ${{ matrix.command }}
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: senseframe-${{ matrix.platform }}
          path: |
            dist/*.dmg
            dist/*.zip
            dist/*.exe
            dist/*.blockmap
            dist/latest*.yml
          if-no-files-found: ignore
```

如果用 electron-builder 直接发布到 GitHub Releases，需要在 `electron-builder.yml` 配置：

```yaml
publish:
  provider: github
  releaseType: draft
```

并在构建命令里加：

```json
"dist:mac": "pnpm run build && electron-builder --mac --publish always",
"dist:win": "pnpm run build && electron-builder --win --publish always"
```

第一版我建议先用 `upload-artifact`，确认包产物没问题后，再打开 `--publish always`。

## electron-builder 配置

建议新增：

```text
electron-builder.yml
```

MVP 配置：

```yaml
appId: com.senseframe.desktop
productName: SenseFrame
directories:
  output: dist
files:
  - out/**
  - package.json
extraResources:
  - from: python
    to: python
    filter:
      - "**/*"
asarUnpack:
  - "**/*.node"
mac:
  target:
    - dmg
    - zip
  category: public.app-category.photography
  hardenedRuntime: false
  gatekeeperAssess: false
win:
  target:
    - nsis
  artifactName: "${productName}-${version}-${arch}.${ext}"
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
publish:
  provider: github
  releaseType: draft
npmRebuild: true
nativeRebuilder: sequential
```

说明：

- `out/**` 是 `electron-vite build` 的产物。
- `extraResources.python` 先把 `python/worker.py` 和模型文件带进包里。
- `asarUnpack` 给 native `.node` 文件留空间。
- macOS 签名第一阶段先关闭。
- Windows 第一阶段先生成 unsigned NSIS。

## Python worker 风险

当前代码：

```ts
function pythonBin(): string {
  const root = app.getAppPath();
  const local = join(root, '.venv', 'bin', 'python');
  return existsSync(local) ? local : 'python3';
}

function workerPath(): string {
  const root = app.getAppPath();
  return join(root, 'python', 'worker.py');
}
```

打包后有两个问题：

1. `python/worker.py` 如果放进 `extraResources`，路径不在 `app.getAppPath()`，而在 `process.resourcesPath`。
2. 用户机器不一定有 `python3` 和依赖。

第一阶段处理：

- 先把 `python` 目录放进 `extraResources`。
- 修改 `workerPath()`：打包后优先找 `process.resourcesPath/python/worker.py`。
- `pythonBin()` 第一阶段仍 fallback 到系统 `python3`。
- app 内提示用户缺少 Python worker dependencies。

第二阶段处理：

- 用 PyInstaller / Nuitka 把 worker 打成 macOS / Windows 可执行文件。
- CI 里分别构建 `senseframe-python-worker`。
- electron-builder 把 worker executable 放进 `extraResources`.

## Native 依赖风险

项目里有：

- `better-sqlite3`
- `sharp`

它们是 native dependencies。

CI 上必须：

- 在目标平台 runner 上安装依赖。
- 让 electron-builder rebuild native deps。
- 不要跨平台复用 `node_modules` artifact。

配置：

```yaml
npmRebuild: true
nativeRebuilder: sequential
```

如果失败，再增加：

```json
"postinstall": "electron-builder install-app-deps"
```

或者在 workflow 里加：

```yaml
- name: Rebuild Electron native deps
  run: pnpm exec electron-builder install-app-deps
```

## 版本号流程

推荐手动版本流程：

```bash
pnpm version patch --no-git-tag-version
git add package.json pnpm-lock.yaml
git commit -m "chore: release v0.1.1"
git tag v0.1.1
git push origin main --tags
```

GitHub Actions 从 tag 触发。

要求：

- tag 必须和 `package.json version` 一致。
- release 名称使用 tag。
- release draft 里包含 mac 和 windows artifacts。

后续可以接 `changesets` 或 `semantic-release`，但第一版不需要。

## 签名和公证规划

### 第一阶段

不签名。

用途：

- 内部测试。
- 验证安装包结构。
- 验证 native deps。
- 验证 Python worker 路径。

### 第二阶段：macOS 签名和公证

需要 GitHub Secrets：

```text
APPLE_ID
APPLE_APP_SPECIFIC_PASSWORD
APPLE_TEAM_ID
CSC_LINK
CSC_KEY_PASSWORD
```

需要配置：

- Developer ID Application 证书。
- `@electron/notarize`。
- electron-builder `afterSign` hook。

### 第二阶段：Windows 签名

需要：

```text
WIN_CSC_LINK
WIN_CSC_KEY_PASSWORD
```

或者后续接 Azure Trusted Signing。

## 推荐落地阶段

### 阶段 1：CI 编译检查

目标：

- PR / main push 跑 `pnpm install`、`typecheck`、`build`。

新增：

```text
.github/workflows/ci.yml
```

### 阶段 2：Release artifacts

目标：

- tag 触发 macOS / Windows build。
- 上传 artifact。
- 不创建 GitHub Release 或只创建 draft。

### 阶段 3：electron-builder draft release

目标：

- 自动创建 GitHub Release draft。
- 自动上传 `.dmg` / `.zip` / `.exe`。

### 阶段 4：签名、公证

目标：

- macOS 可以被正常打开。
- Windows 安装包有签名。

### 阶段 5：自动更新

目标：

- 接 `electron-updater`。
- 应用内检测新版本。

## 最小落地文件清单

第一批要加：

```text
electron-builder.yml
.github/workflows/ci.yml
.github/workflows/release.yml
```

要改：

```text
package.json
electron/main/pythonWorker.ts
```

可选：

```text
build/icon.icns
build/icon.ico
```

## 验收标准

第一阶段完成后：

- GitHub Actions 能在 PR / main 上跑通 typecheck + build。
- 打 tag 后能触发 release workflow。
- macOS runner 生成 `.dmg` 和 `.zip`。
- Windows runner 生成 `.exe`。
- artifacts 能从 GitHub Actions 下载。
- app 能启动到主界面。
- Python worker 不可用时有明确提示，不崩溃。

## 结论

SenseFrame 的 GitHub CI/CD 第一版应该走：

```text
GitHub Actions + pnpm + electron-vite build + electron-builder
```

先实现 unsigned 内测包，跑通 macOS / Windows artifacts。等安装包结构、native deps、Python worker 路径稳定后，再接 GitHub Release draft、macOS 签名公证、Windows 签名和自动更新。
