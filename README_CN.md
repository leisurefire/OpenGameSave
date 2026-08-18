# OpenGameSave
## 安心享受游戏。

[English](./README.md) | 中文

<div align="center">
    <img src="src/assets/logo.png" alt="OpenGameSave logo" width="250" />
</div>

> 开发人员名单：[leisurefire](https://github.com/leisurefire)。曾经开发人员名单：Yongcan Yang。本 fork 项目地址为 [leisurefire/OpenGameSave](https://github.com/leisurefire/OpenGameSave)。

将 Steam、Epic 乃至自定义位置的游戏存档，悉数保存，一键还原。你的进度，你说了算。

---

### 全新界面
悉心考量细节，融合 Windows 11 云母材质效果，通透优雅。

### 备好后悔药
可自动保留滚动备份历史，也手动为你的史诗留下注脚。

### 云端漫步（开发中）
在即将到来的更新中，你将能够自定义备份路径，将宝贵存档无缝接入 GitHub 仓库或 Google Drive 等平台。

### 海量支持
基于 PCGamingWiki 数据库，轻松支持超过 14,000 款游戏的存档位置。

项目还会使用 MIT 许可的 Ludusavi Manifest 与 XgpSaveTools 登记表。GitHub Actions 会分别发布“标准版”和“Xbox 增强版”数据库；Xbox 登记表仅合并到临时构建数据库，不会覆盖仓库中的标准数据库。详见[数据库来源与 Xbox 格式说明](database/SOURCES.md)。

用户可在设置中选择数据库版本，再开启“自动检查数据库更新”或点击“更新数据库”。两个版本各自维护连续增量补丁和完整数据库回退；切换版本时始终下载完整数据库，避免跨版本混用补丁。

### 无缝迁徙
换了新电脑？只需导出一个极简的 .gsmr 归档文件，在新设备上一键导入。

## 安装
即刻前往[最新发布页面](https://github.com/leisurefire/OpenGameSave/releases/latest)，下载为 Windows 打造的最新安装包，启动 OpenGameSave，安心享受游戏。

已安装的应用可在启动时检查软件更新。发现新版本后，点击“选项”右侧的下载按钮；OpenGameSave 会校验发布元数据、下载安装包、安全退出、完成安装并重新启动。

## 开发人员名单
- 开发人员名单：[leisurefire](https://github.com/leisurefire)
- 曾经开发人员名单：Yongcan Yang

WebDAV 必须使用 HTTPS。本地集成测试可同时设置 `NODE_ENV=development` 与 `OPENGAMESAVE_ALLOW_INSECURE_LOCALHOST=1`，仅对回环地址显式启用 HTTP。

## 许可
OpenGameSave 基于 GPL-3.0-only 许可发布。随项目分发的 MIT 数据库来源详见[第三方声明](THIRD_PARTY_NOTICES.md)。
