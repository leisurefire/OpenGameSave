<p align="center">
  <img src="src/assets/logo.png" alt="OpenGameSave 标志" width="220">
</p>

<h1 align="center">OpenGameSave</h1>

<p align="center"><strong>在一个 Windows 应用中备份、还原、迁移与同步 PC 游戏存档。</strong></p>

<p align="center">
  <a href="README.md">English</a> · 简体中文
</p>

<p align="center">
  <a href="https://github.com/leisurefire/OpenGameSave/releases/latest"><img src="https://img.shields.io/github/v/release/leisurefire/OpenGameSave?label=release" alt="最新版本"></a>
  <a href="https://github.com/leisurefire/OpenGameSave/actions/workflows/test.yml"><img src="https://github.com/leisurefire/OpenGameSave/actions/workflows/test.yml/badge.svg" alt="CI 状态"></a>
  <a href="LICENSE.txt"><img src="https://img.shields.io/badge/license-GPL--3.0--only-2ea44f.svg" alt="GPL-3.0-only 许可"></a>
</p>

## 项目简介

OpenGameSave 是一款以本地操作为核心的桌面应用，用于查找、备份、还原、导出和同步 PC 游戏存档。内置数据库包含超过 14,000 款游戏的存档位置映射，也可通过自定义安装根目录覆盖未被自动识别的游戏。

应用围绕可恢复快照设计：保留滚动历史、永久保存重要备份，并在旧备份将要覆盖较新的本地数据前提示确认。

> [!IMPORTANT]
> Xbox PGS 存档**仅支持备份**。这些快照由 Xbox Gaming Services 和云同步管理，因此 OpenGameSave 会主动禁止自动还原和删除。

## 主要功能

- **统一的已安装游戏库**——扫描 Steam、Epic Games、GOG 和 Battle.net；可搜索、按平台筛选、启动游戏或打开安装目录。
- **广泛的存档识别**——备份数据库定义的文件、目录和 Windows 注册表数据，添加自定义安装根目录，并可扫描已卸载游戏残留的存档。
- **版本化备份**——批量备份多个游戏，配置每款游戏保留的普通快照数量，并将重要快照标记为永久保留。
- **按游戏自动备份**——可按自定义时间间隔执行，也可在监视到存档文件变化时执行。
- **更安全的还原**——本地数据较新时发出警告，按当前可信数据库定义重新授权目标路径，并在还原失败时回滚文件系统和注册表更改。
- **便携迁移**——将全部或选中的备份导出为经过校验的 `.gsmr` 归档，并在另一台电脑上导入。
- **已经可用的云同步**——通过现有 GitHub 仓库或 HTTPS WebDAV 服务器上传和下载备份。
- **数据库与攻略链接**——选择“标准版”或“Xbox 增强版”数据库，为匹配游戏打开精确的 PCGamingWiki 技术页面，并在具备人工审核来源时提供额外链接。
- **英文与简体中文界面**——支持自定义侧栏、Windows 云母材质和可选的系统强调色。

## 平台与要求

- **当前只有 Windows 提供官方安装包。** 源码包含部分带平台保护的跨平台实现，但目前不发布或支持 macOS 与 Linux 版本。
- Windows 11 可呈现完整的云母材质效果。仓库并未声明具体的最低 Windows 版本。
- Git 为可选依赖，仅在使用 GitHub 同步时需要。
- WebDAV 同步必须使用 HTTPS 地址。除显式启用的回环地址开发测试外，应用会拒绝明文 HTTP。
- 请为原始存档和计划保留的备份历史预留足够磁盘空间。

## 安装

1. 打开[最新发布页面](https://github.com/leisurefire/OpenGameSave/releases/latest)。
2. 下载 `OpenGameSave-Setup-<version>.exe` 并运行安装程序。
3. 打开“选项”，确认备份存储文件夹并检查已识别的游戏安装根目录。
4. 打开“存档”，选择需要保护的游戏并创建第一份备份。

官方版本由 Windows 发布工作流构建，该流程要求安装包具备有效签名和经过校验的更新元数据。已安装版本可在启动时检查更新；发现新版本后，使用“选项”旁的下载按钮。预发布版本更新默认不启用。

## 快速上手

1. **选择存储位置。** Windows 默认备份目录为 `%APPDATA%\OGS Backups`，可在设置中修改。之后更改目录时会使用内置迁移流程。
2. **查找游戏。** 打开“游戏库”扫描受支持的启动器。在设置中自动检测或添加用于匹配存档的安装根目录；如需查找已卸载游戏的残留存档，可启用完整数据库扫描。
3. **创建快照。** 在“存档 → 备份”中选择一款或多款游戏并执行备份。通过“管理备份”为快照命名、永久保留或删除快照。
4. **谨慎还原。** 在“存档 → 还原”中选择快照。如果电脑上的存档更新，OpenGameSave 会询问要跳过还是替换。
5. **自动化或迁移。** 为单款游戏启用定时或文件变化自动备份，也可将选中的历史导出为 `.gsmr` 归档。

游戏更新后，存档位置也可能变化。依赖第一份备份前，请确认其中包含预期数据；对于无法替代的存档，请额外保留一份独立副本。

## 同步

云同步现在已经可用，但它不是自动运行的后台服务：请在“同步”页面主动使用“检查”“上传本地备份”或“下载备份”。

| 提供方 | 配置 | 行为 | 凭据 |
| --- | --- | --- | --- |
| GitHub 仓库 | 安装 Git，并将备份目录设为目标 GitHub 仓库本地克隆的根目录；其 `origin` 必须指向目标仓库。 | 远端 `origin/main` 存在时先拉取，应用保留策略后提交并推送本地备份。下载使用仅快进拉取，并校验导入的备份元数据。 | 完全由本机 Git 配置或凭据助手管理；OpenGameSave 不读取 Git 凭据。 |
| WebDAV | 填写 HTTPS 服务器地址、可选的用户名和密码以及远端目录。 | 上传变化内容、校验远端对象、以事务方式合并下载，并在多设备冲突时保留双方版本。 | 密码通过 Electron `safeStorage` 绑定当前操作系统账户加密；保存后不会再返回渲染进程。 |

OpenGameSave 本身不会加密备份内容。请使用私有 GitHub 仓库或可信的 WebDAV 服务，并优先使用 WebDAV 应用专用密码。

## Xbox 数据库说明

设置中提供两个独立更新的数据库版本：

- **标准版**——基于 PCGamingWiki 的普通数据库，并包含来自 Ludusavi Manifest 的审核后补充。
- **Xbox 增强版**——在生成的副本中额外合并 MIT 许可 XgpSaveTools 登记表中兼容的 WGS/PGS 映射。

切换版本时会安装经过校验的完整数据库；同版本更新可使用连续增量补丁，并在需要时回退为完整数据库。Xbox PGS 位置可以复制到备份，但 OpenGameSave 不会自动还原或删除它们。设计原因和更新方式详见[数据库来源与 Xbox 存档格式](database/SOURCES.md)。

## 数据与隐私

- 备份、扫描、导出、导入和还原均在本机执行。备份目录和 `.gsmr` 归档可能包含存档文件、注册表导出、与游戏账户相关的数据和元数据；这些内容**不会由 OpenGameSave 加密**。
- 设置位于 Electron 用户数据目录下的 `OGS Settings/settings.json`；可更新数据库位于 `OGS Database/database.db`；致命错误日志写入 `logs/` 目录。
- 当前仓库未集成分析或遥测功能。
- 应用可能连接 GitHub 以检查应用或数据库更新；缺少游戏库图片时，也可能从受大小限制和域名白名单保护的 Steam、Epic、GOG 或暴雪官方资源获取图片。攻略和项目链接会在系统浏览器中打开。
- 只有在你配置提供方并主动执行同步操作后，GitHub 或 WebDAV 才会收到备份内容。Git 凭据始终由 Git 管理；WebDAV 密码使用操作系统支持的加密。同一操作系统账户下的其他进程仍属于相同信任边界。
- 错误日志可能包含技术细节或本地路径。公开分享日志和归档前请先检查内容。

渲染进程已禁用 Node.js 集成，并启用上下文隔离、沙箱、严格的内容安全策略以及按页面角色划分的默认拒绝 IPC 桥。文件系统、注册表、归档、URL 和同步输入均在主进程中校验。

## 数据库与来源

主要游戏数据库基于 PCGamingWiki。定期维护还会使用 MIT 许可的 [Ludusavi Manifest](https://github.com/mtkennerly/ludusavi-manifest)；Xbox 增强版使用 MIT 许可 [XgpSaveTools](https://github.com/brodrigz/XgpSaveTools) 登记表中的部分映射。OpenGameSave 只链接外部攻略内容，不会重新分发这些文章或游戏图片。

数据来源、更新工作流和 Xbox 格式说明见 [database/SOURCES.md](database/SOURCES.md)。完整的第三方声明和来源许可位于 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 `database/licenses/`。

## 开发

CI 和发布工作流使用 **Node.js 24** 与 npm。建议在 Windows 上运行完整应用，因为注册表处理、启动器检测、通知和官方打包流程均以 Windows 为主。

请在仓库根目录运行：

```powershell
npm ci

# Tailwind 与 Webpack 监视器，加上 Electron
npm run dev

# 代码检查、checkJs 类型检查、覆盖率测试与生产构建
npm run check

# 单独执行检查
npm run lint
npm run typecheck
npm run test
npm run test:coverage

# 构建或启动
npm run build
npm start

# 本地打包
npm run app:dir
npm run app:dist
```

`npm run build` 将生产 bundle 写入 `dist/out`。`npm start` 会先执行生产构建并重新构建 Electron 原生依赖，再启动应用。`npm run app:dir` 创建用于本地验收的未打包应用；`npm run app:dist` 创建本地发行文件，官方签名版本仅由发布工作流生成。如只需编译共享 Tailwind CSS，可运行 `npm run styles:build`。

数据库维护者在使用 `db:sync:*` 脚本前，应先阅读 [database/SOURCES.md](database/SOURCES.md) 中的预览与应用规则。

## 架构

```text
src/main/       Electron 生命周期、IPC 处理器、工作线程、备份/还原、
                同步、数据库更新与操作系统集成
src/preload/    按页面角色划分、通过 contextBridge 暴露的 API
src/shared/     共享 IPC 策略与游戏库虚拟化代码
src/renderer/   主界面、设置、关于、模态与菜单页面，组件和 CSS
src/locale/     英文与简体中文翻译
src/data/       经审核的攻略目录源文件
database/       受版本控制的标准版 SQLite 数据库、来源元数据与许可
scripts/        构建、发布、数据库同步与校验工具
test/           Node 测试运行器测试套件
```

Webpack 分别构建主进程、预加载和渲染进程目标。备份与数据库工作使用受限工作线程池，已安装游戏库扫描则在独立工作线程中执行，避免长时间操作阻塞界面。

## 贡献

欢迎提交错误报告、游戏支持请求、文档修复和范围明确的拉取请求。

1. 请先搜索[现有问题](https://github.com/leisurefire/OpenGameSave/issues)，并在适用时使用仓库的错误报告或新增游戏表单。
2. 保持改动聚焦并保护用户存档。面向用户的文本必须同时加入 `src/locale/en_US.json` 和 `src/locale/zh_CN.json`。
3. 不要削弱渲染进程沙箱、IPC 授权、路径校验、归档校验或还原确认流程。
4. 提交拉取请求前运行 `npm run check`。
5. 不要提交个人存档、设置、日志、凭据、安装包或生成的 `dist/` 输出。

数据库改动需遵守 [database/SOURCES.md](database/SOURCES.md) 中的匹配、许可和预览要求。项目不接受盗版游戏的存档路径。

## 维护者与致谢

- 当前维护者：[leisurefire](https://github.com/leisurefire)
- 原作者及前开发者：Yongcan Yang

本 fork 维护于 [leisurefire/OpenGameSave](https://github.com/leisurefire/OpenGameSave)。

## 许可

OpenGameSave 基于 [GPL-3.0-only](LICENSE.txt) 许可发布。独立许可的数据库来源和外部内容声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
