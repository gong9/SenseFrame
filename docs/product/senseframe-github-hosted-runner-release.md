---
title: SenseFrame GitHub 官方 Runner 打包发布简化方案
date: 2026-05-03
tags:
  - project/AI选片
  - product/SenseFrame
  - cicd
  - github-actions
aliases:
  - SenseFrame GitHub Runner 发布方案
  - SenseFrame 官方 Runner 打包
  - SenseFrame GitHub Release 下载方案
---

# SenseFrame GitHub 官方 Runner 打包发布简化方案

> [!summary]
> SenseFrame 第一版发布不需要自建 runner、不需要部署服务器、不需要对象存储、不需要自动更新。直接使用 GitHub 官方托管 runner 构建 macOS / Windows 安装包，把产物上传到 GitHub Releases，用户自己下载安装即可。

## 结论

我们要接的是最简单可靠的 GitHub CI/CD：

```text
GitHub-hosted runner
  + electron-builder
  + GitHub Releases
  + 用户自行下载 dmg / exe
```

不需要：

- self-hosted runner。
- 私有构建服务器。
- 下载站点。
- S3 / OSS 对象存储。
- 自动更新。
- 复杂部署流水线。

第一阶段只做：

- macOS 安装包。
- Windows 安装包。
- GitHub Release draft。
- 用户去 Release 页面下载。

## Runner 选择

GitHub Actions 的 runner 是执行构建 job 的机器。

SenseFrame 使用 GitHub 官方 runner：

```yaml
runs-on: macos-latest
runs-on: windows-latest
```

用途：

| 平台 | Runner | 产物 |
| --- | --- | --- |
| macOS | `macos-latest` | `.dmg` / `.zip` |
| Windows | `windows-latest` | `.exe` |

不使用：

```yaml
runs-on: self-hosted
```

原因：

- 现在没有必要维护自己的机器。
- GitHub 官方 runner 足够构建 Electron 安装包。
- 用户只需要下载 release，不需要我们部署服务。
- 自建 runner 会增加安全、磁盘、缓存、环境维护成本。

## 用户下载路径

用户获取 SenseFrame 的方式：

```text
打开 GitHub Releases
  -> 找到最新版本
  -> 下载对应平台安装包
  -> 本地安装
```

Release 产物示例：

```text
SenseFrame-0.1.0-mac.dmg
SenseFrame-0.1.0-mac.zip
SenseFrame-0.1.0-win.exe
```

## 发布流程

开发侧流程：

```text
1. 修改 package.json version
2. 提交代码
3. 打 tag，例如 v0.1.0
4. 推送 tag 到 GitHub
5. GitHub Actions 自动构建
6. 自动创建 GitHub Release draft
7. 人工检查安装包
8. 发布 Release
```

命令示例：

```bash
pnpm version patch --no-git-tag-version
git add package.json pnpm-lock.yaml
git commit -m "chore: release v0.1.1"
git tag v0.1.1
git push origin main --tags
```

## GitHub Actions 工作流

新增：

```text
.github/workflows/release.yml
```

建议 workflow：

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
  build:
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

      - name: Build installer
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
          if-no-files-found: error
```

第一版也可以先只上传 Actions artifacts，不直接创建 GitHub Release。

但面向用户下载，推荐最终使用 GitHub Releases。

## electron-builder 配置

新增：

```text
electron-builder.yml
```

推荐 MVP 配置：

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

## package.json 脚本

新增：

```json
{
  "scripts": {
    "dist": "pnpm run build && electron-builder",
    "dist:mac": "pnpm run build && electron-builder --mac",
    "dist:win": "pnpm run build && electron-builder --win"
  }
}
```

如果要自动上传到 GitHub Release draft：

```json
{
  "scripts": {
    "dist:mac": "pnpm run build && electron-builder --mac --publish always",
    "dist:win": "pnpm run build && electron-builder --win --publish always"
  }
}
```

## 第一版签名策略

第一版内部测试可以先不签名。

影响：

- macOS 用户可能需要右键打开，或者在安全设置里允许。
- Windows 可能出现 SmartScreen 提示。

这对内部测试可接受。

正式公开分发再接：

- macOS Developer ID 签名和公证。
- Windows 代码签名。

## 当前项目需要特别处理的点

### 1. Native 依赖

项目有：

- `better-sqlite3`
- `sharp`

所以要在目标平台 runner 上分别构建，不要交叉构建。

配置：

```yaml
npmRebuild: true
nativeRebuilder: sequential
```

### 2. Python worker

当前 Python worker 打包后路径可能不对。

第一版：

- 先把 `python/` 放进 `extraResources`。
- app 打包后从 `process.resourcesPath/python/worker.py` 找 worker。
- Python 解释器暂时 fallback 到系统 `python3`。

后续：

- 把 Python worker 打成平台可执行文件。
- macOS / Windows runner 分别构建 worker。
- 随安装包分发。

## 最小文件改动

要新增：

```text
.github/workflows/release.yml
electron-builder.yml
```

要修改：

```text
package.json
electron/main/pythonWorker.ts
```

可选：

```text
.github/workflows/ci.yml
```

`ci.yml` 可以在 PR / main push 时只跑：

```text
pnpm install
pnpm run typecheck
pnpm run build
```

## 验收标准

完成后应该满足：

- 打 tag 后 GitHub Actions 自动启动。
- macOS job 在 GitHub 官方 runner 上成功。
- Windows job 在 GitHub 官方 runner 上成功。
- 生成 `.dmg`、`.zip`、`.exe`。
- 产物可以从 GitHub Actions artifact 或 GitHub Release 下载。
- 用户下载后可以安装并打开 SenseFrame。
- Python worker 不可用时有明确提示，不导致主程序崩溃。

## 当前已落地

已新增：

```text
.github/workflows/ci.yml
.github/workflows/release.yml
electron-builder.yml
```

已修改：

```text
package.json
pnpm-lock.yaml
electron/main/pythonWorker.ts
```

当前行为：

- `ci.yml` 在 PR / main push 时执行依赖安装、类型检查和生产构建。
- `release.yml` 在 `v*.*.*` tag 触发时使用 GitHub 官方 `macos-latest` / `windows-latest` runner 构建安装包。
- release workflow 会先上传 GitHub Actions artifacts。
- tag 触发时还会创建或更新 GitHub Release draft，并上传 `.dmg`、`.zip`、`.exe`。
- `electron-builder.yml` 已配置 macOS `dmg/zip` 和 Windows `nsis`。
- `python/` 已配置为 `extraResources`。
- 打包后 Python worker 会优先从 `process.resourcesPath/python/worker.py` 读取。

本地验证：

```text
pnpm install --frozen-lockfile 通过
pnpm run typecheck 通过
pnpm run build 通过
```

本机 `electron-builder --dir` 已开始执行并完成 native dependency rebuild，但下载 Electron 运行时 zip 时 GitHub release asset 中途 EOF，未完成本地 unpacked app 生成。这个失败发生在本机网络下载阶段，不是配置语法或 TypeScript 构建失败；GitHub runner 上会重新下载。

## 最终简化方案

SenseFrame 第一版发布链路就是：

```text
tag version
  -> GitHub-hosted macOS runner
  -> GitHub-hosted Windows runner
  -> electron-builder
  -> GitHub Releases
  -> 用户下载
```

这条链路最简单、维护成本最低，也符合当前产品阶段。
