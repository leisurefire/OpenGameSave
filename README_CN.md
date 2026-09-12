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
- 应用界面需要 Microsoft Edge WebView2 Runtime。
- Git 为可选依赖，仅在使用 GitHub 同步时需要。
- WebDAV 同步必须使用 HTTPS 地址。除显式启用的回环地址开发测试外，应用会拒绝明文 HTTP。
- 请为原始存档和计划保留的备份历史预留足够磁盘空间。

## 安装

1. 打开[最新发布页面](https://github.com/leisurefire/OpenGameSave/releases/latest)。
2. 下载 `OpenGameSave_<version>_x64-setup.exe` 并运行安装程序。
3. 在“同步”中确认备份存储文件夹，再到“设置”检查已识别的游戏安装根目录。
4. 打开“存档”，选择需要保护的游戏并创建第一份备份。

官方版本由 Windows 发布工作流构建，该流程要求安装包具备有效签名和经过校验的更新元数据。已安装版本可在启动时检查更新；发现新版本后，使用“选项”旁的下载按钮。预发布版本更新默认不启用。

## 快速上手

1. **选择存储位置。** Windows 默认备份目录为 `%APPDATA%\OGS Backups`，可在“同步”中修改。之后更改目录时会使用内置迁移流程。
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
| WebDAV | 填写 HTTPS 服务器地址、可选的用户名和密码以及远端目录。 | 上传变化内容、校验远端对象、以事务方式合并下载，并在多设备冲突时保留双方版本。 | 密码通过 Windows Credential Manager / DPAPI 绑定当前操作系统账户加密；保存后不会再返回渲染进程。 |

OpenGameSave 本身不会加密备份内容。请使用私有 GitHub 仓库或可信的 WebDAV 服务，并优先使用 WebDAV 应用专用密码。

## Xbox 数据库说明

设置中提供两个独立更新的数据库版本：

- **标准版**——基于 PCGamingWiki 的普通数据库，并包含来自 Ludusavi Manifest 的审核后补充。
- **Xbox 增强版**——在生成的副本中额外合并 MIT 许可 XgpSaveTools 登记表中兼容的 WGS/PGS 映射。

切换版本时会安装经过校验的完整数据库；同版本更新可使用连续增量补丁，并在需要时回退为完整数据库。Xbox PGS 位置可以复制到备份，但 OpenGameSave 不会自动还原或删除它们。设计原因和更新方式详见[数据库来源与 Xbox 存档格式](database/SOURCES.md)。

## 数据与隐私

- 备份、扫描、导出、导入和还原均在本机执行。备份目录和 `.gsmr` 归档可能包含存档文件、注册表导出、与游戏账户相关的数据和元数据；这些内容**不会由 OpenGameSave 加密**。
- 设置位于 OpenGameSave 用户数据目录下的 `OGS Settings/settings.json`；可更新数据库位于 `OGS Database/database.db`；致命错误日志写入 `logs/` 目录。
- 当前仓库未集成分析或遥测功能。
- 应用可能连接 GitHub 以检查应用或数据库更新；缺少游戏库图片时，也可能从受大小限制和域名白名单保护的 Steam、Epic、GOG 或暴雪官方资源获取图片。攻略和项目链接会在系统浏览器中打开。
- 只有在你配置提供方并主动执行同步操作后，GitHub 或 WebDAV 才会收到备份内容。Git 凭据始终由 Git 管理；WebDAV 密码使用操作系统支持的加密。同一操作系统账户下的其他进程仍属于相同信任边界。
- 错误日志可能包含技术细节或本地路径。公开分享日志和归档前请先检查内容。

界面运行在 WebView2 中，不包含 Node.js。严格的内容安全策略和按窗口角色划分的默认拒绝命令边界由 Tauri 与 Rust 宿主执行。文件系统、注册表、归档、URL 和同步输入均在 Rust 中校验。

## 数据库与来源

主要游戏数据库基于 PCGamingWiki。定期维护还会使用 MIT 许可的 [Ludusavi Manifest](https://github.com/mtkennerly/ludusavi-manifest)；Xbox 增强版使用 MIT 许可 [XgpSaveTools](https://github.com/brodrigz/XgpSaveTools) 登记表中的部分映射。OpenGameSave 只链接外部攻略内容，不会重新分发这些文章或游戏图片。

数据来源、更新工作流和 Xbox 格式说明见 [database/SOURCES.md](database/SOURCES.md)。完整的第三方声明和来源许可位于 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 `database/licenses/`。

## 开发

桌面运行时已迁移至 **Tauri 2 + Rust**，前端使用原有 JavaScript、HTML、CSS 和 Webpack。运行应用无需 Electron、Node.js 或 JavaScript 后台进程。Node.js 24 与 npm 用于前端构建、测试和数据库维护工具。

Windows 开发需要 [Tauri 前置依赖](https://v2.tauri.app/start/prerequisites/)：Rust stable（`src-tauri/Cargo.toml` 声明最低 1.93）、Visual Studio C++ Build Tools 和 WebView2。仓库的 `rust-toolchain.toml` 选择 stable 工具链；完整发行测试以 Windows 为准。

```powershell
npm ci
npm run dev                 # 构建前端并启动 Tauri 开发窗口
npm run check               # JS 检查/测试、Rust Clippy/测试、前端构建
npm run build               # 构建 Rust 桌面程序，不生成安装包
npm run app:dist            # 构建本地未签名的 Windows NSIS 安装包
npm run rust:test           # 临时文件/数据库/注册表与本地 WebDAV 测试
npm run frontend:build      # 仅构建 Web 前端
```

前端输出位于 dist/out/renderer，桌面程序位于 src-tauri/target/release，安装包位于 src-tauri/target/release/bundle/nsis。开发时修改前端后运行 npm run frontend:build 并重新加载窗口；Rust 修改由 Tauri CLI 监视。

## 架构与迁移

```text
src-tauri/src/           Tauri 生命周期、原生窗口、权限、设置和应用服务
src-tauri/src/saves/     SQLite、存档扫描、备份、还原授权、事务、归档和数据库更新
src-tauri/src/sync/      Git/WebDAV、操作系统凭据、校验、合并与事务恢复
src-tauri/src/library/   启动器/账号发现、游戏库图片、攻略匹配
src/renderer/           Web 前端与异步 Tauri 通信桥
src/shared/             前后端共用的窗口角色权限契约和虚拟列表逻辑
scripts/                前端/发行构建与数据库维护工具
scripts/lib/            仅供维护脚本使用的 JavaScript 数据校验
```

Rust 按原生窗口注册的角色和精确页面校验每个命令，只向授权窗口发送事件。前端不具备通用文件系统、进程、网络或外部窗口创建权限。文件、数据库和网络工作通过阻塞任务池执行；修改备份、还原、同步与数据库的操作共用互斥锁，退出时等待在途操作完成。

Windows 继续使用 %APPDATA%/opengamesave/OGS Settings/settings.json 和 OGS Database/database.db，默认备份目录仍为 %APPDATA%/OGS Backups。迁移不会移动现有备份；旧分钟/秒时间戳、backup_info.json 和 7z 格式 .gsmr 可继续读取，也接受受限校验后的 ZIP .gsmr。WebDAV 旧 DPAPI 密码会尝试导入 Windows 凭据管理器；无法解密时需要重新输入密码，旧凭据文件会保留。

从 Electron 发行版首次切换时，请手动安装 Tauri 版本。旧版 Electron 更新元数据与 Tauri 签名清单不同。后续 Tauri 发行版使用签名更新；本地未嵌入更新公钥的构建会打开发布页面供下载。

签名发布使用 GitHub 的 `application-release` 环境。Windows Authenticode 需要 `WINDOWS_CSC_LINK`（base64 PFX 或 HTTPS PFX 地址）、`WINDOWS_CSC_KEY_PASSWORD`、`WINDOWS_PUBLISHER_NAME` secrets；Tauri 更新签名需要 `TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets，并将配对公钥设为仓库或环境的公开变量 `TAURI_UPDATER_PUBLIC_KEY`。两者使用独立的签名身份，应用只嵌入更新公钥。

工作流运行 `npm run app:dist:release`，验证安装包证书和下载回来的远端文件哈希后才发布。本地签名打包也使用此命令，需要 `OGS_UPDATER_PUBLIC_KEY`、`TAURI_SIGNING_PRIVATE_KEY`、私钥的可选密码及已导入 Windows 证书的 `OGS_CERTIFICATE_THUMBPRINT`。普通 `npm run app:dist` 不需要这些凭据，生成本地未签名安装包。已实现项目及剩余原生窗口和安装包验证状态见 [MIGRATION.md](MIGRATION.md)。

数据库维护者在使用 db:sync:* 脚本前，应先阅读 [database/SOURCES.md](database/SOURCES.md)。

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
