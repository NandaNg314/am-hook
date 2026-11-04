# AGENTS.md — am-hook 维护守则

> 给接手本项目的编码 Agent 看的**实用守则**。重点是让改动可预期、可回滚、别炸线上用户。
> 这里只写"光看代码不容易发现"的东西：约定、陷阱、验证口径。具体的文件名、脚本、端口以仓库和服务器现状为准；服务器地址、密钥这类信息放在本机运维手册里，**不进这个仓库**。
> 改之前先扫一遍 §1 和 §2；不确定的按 §8 处理。

---

## 0. 先搞清这是什么

Apple Music 高保真下载/转存服务，四个组成部分：

| 部分 | 位置 | 语言 | 角色 |
| :--- | :--- | :--- | :--- |
| Web 后端 | `src/**`、`crates/**` | Rust | 解析 Apple Music 链接、拉 HLS、配合 CDM 解密、托管前端静态资源 |
| 转存服务 | `cloud-service.mjs` | Node.js | 元数据分流、注入标签/封面/歌词、打包 ZIP、传 Gofile、配额 |
| TG 机器人 | `tg-bot.mjs` | Node.js | 点歌、艺人/专辑/歌单浏览、批量下载、双语 UI、秒传缓存 |
| Web 前端 | `src/ui/**` | 原生 JS + CSS | 单页应用，**编译进 Rust 二进制**（见 §1、§5） |

用户分两类，行为差异很大，改任何"元数据 / 文案 / 配额"逻辑前先想清楚给谁看：

- **中文用户**：华语曲目要简体中文标签；欧美/古典/日文歌手保持原名。
- **英文用户**：所有标签、文件名、UI 文案走英文。

---

## 1. 必须守住的几条（破坏即事故）

1. **改了 `src/ui/**` 就要重编 Rust**。前端通过 `include_bytes!` 烘焙进二进制，只改文件不重编等于没改。完整流程见 §5。
2. **重启前先看有没有人在用**。统一走 `safe-restart`（自带空闲检测），它会在队列空、没人连着、近期无转存时才动手。详见 §5。
3. **临时资源要有兜底清理**。`/tmp` 下的会话目录、ZIP、歌词临时文件，用 `try/finally` 保证任何分支都能删掉；攒满磁盘会让所有转存一起挂。
4. **大文件走流式**。ZIP 和音频用 `fs.openAsBlob()` / 流式上传；`readFileSync` 一个大包就能把 Node 打 OOM。
5. **子进程要带超时**。`execFile` / `execFileAsync` 补上 `timeout` 和 `maxBuffer`，免得网络抖动拖死整个服务。
6. **凭据留在本机**。`.env`、`*.key`、`PROJECT_MEMORY.md`、`AGENT_MAINTENANCE.md` 都已 gitignore，新增的敏感文件也按同样方式处理；提交前扫一眼 `git status`。

---

## 2. Apple Music 侧的三个坑（最容易踩）

### 2.1 各 Storefront 支持的 `l` 语言码不一样

这是本项目踩过最多次的坑：`us` / `jp` 的英文码是 `en-US`，而 `hk` / `tw` / `cn` / `tr` / `gb` 只有 `en-GB`。
给港区传 `l=en-US` 不会报错，会**静默回退到繁体中文**，表现出来就是"英文模式没生效"，很难排查。

中文侧同理：`hk` 是 `zh-Hant-HK`，`tw` 是 `zh-Hant-TW`，`cn` / `us` 是 `zh-Hans-CN`。

三处都有统一的语言码封装，别在各处手写语言码：

- `src/ui/i18n.js` → `catalogLang(cc)`
- `cloud-service.mjs` / `tg-bot.mjs` → `catalogLangFor(sf, isEn)`
- `src/ui/views/local-download.mjs` → 同类局部实现

另外，给错误区传不支持的 `l` 并不会返回 400，所以这类问题没法靠状态码发现，只能比对返回内容本身的语种。

### 2.2 "大中华区官方音译名"不是中文名

`us` / `cn` 区对古典、欧美、宝莱坞歌手会返回音译（`Igor Levit` → `伊戈尔・列维特`）。
判断要不要采用中文名，看的是曲目本身是不是华语，而不是"能不能查到中文名"：

- 有汉字 / 命中华语艺人别名表 / 流派是 Mandopop·Cantopop·C-Pop 等 / `audioLocale` 为 `zh|cmn|yue` → 才补中文。
- 远端名字不带汉字、`audioLocale` 非华语、但艺人名里带 `·` / `・` → 判定为音译，放弃中文嗅探，保留英文原名。

### 2.3 `?views=full-albums` 默认只给 10 条

艺人接口的各个 view 都是分页的，首屏只返回 10 项，其余在 `next` 里。
拉艺人作品列表要跟 `next` 翻页（`tg-bot.mjs` 的 `fetchAllViewItems` 就是这么做的），否则用户会看到"只有 10 张专辑"。

---

## 3. 前端约定

- **结构**：`app.html` 是骨架，`app.mjs` 是路由 + 常驻播放条 + 导航，`views/<page>.{html,mjs}` 是页面。页面 `mount()` 里挂在 `signal` 上的监听会随离开页面自动释放，新加的全局监听也这么挂，切页就不会泄漏。
- **双语**：静态文案走 `data-i18n` / `data-i18n-attr`；动态文字放在 `renderXxxI18n()` 里按 `AmI18n.lang` 重绘，并让 `onLangChange` 调它。判断用 `AmI18n.lang === 'en'`，不用自己读 `navigator.language`。
- **深浅色**：颜色统一用 `var(--surface)` / `var(--surface-2)` / `var(--surface-3)` / `var(--line)` / `var(--text)` / `var(--muted)` / `var(--accent)`。写死的 `#1c1c1e`、`#fff` 会在浅色模式下直接糊掉。
- **响应式**：用 Playwright 在 **390×844（手机）** 和 **1440×900（桌面）** 各过一遍，确认 `document.documentElement.scrollWidth <= clientWidth`。横向溢出是本项目最常见的手写样式事故。
- **偏好设置**：`localStorage` 键 `am_gofile_upload` / `am_save_lrc` / `am_lyrics_fmt` 由单曲、专辑、歌单、首页四处共用，改一处记得对齐另三处。
- **动效**：`transform` + `opacity` 就够了；按下反馈用 `:active { transform: scale(.97) }`。

---

## 4. 后端约定

### `cloud-service.mjs`

- 请求体带 `lang`（`'en'` / `'zh'`），元数据分流全靠它。新增入口如果会影响标签，记得把它透传下去。
- 缓存 key 带语言后缀（`${isEn ? '_en' : ''}`）。这条要同时落在 `cloud-service.mjs` 的响应缓存和 `tg-bot.mjs` 的秒传缓存上，只加一处的话，另一侧仍会把中文标签的旧文件发给英文用户。
- 音频容器处理顺序是固定的：`先注入标签 → 再解开碎片`（解碎片内部依次是 ffmpeg 重封装 → 恢复 Atmos JOC → 剥除 btrt）。几处都在改 `stco` 偏移，顺序颠倒会把文件写坏；动手前先看 §8。
- 配额在 `reserveWebQuota` 里整单一次预留，失败走 `refundWebQuota`。如果改成逐首扣，并发下数字会飘，而且是非要跑到一半才发现不够。

### `tg-bot.mjs`

- Telegram inline_keyboard 单条消息上限 **100 个按钮**。列表类界面用分页（每页 20 条 + 上一页/下一页）；直接 `slice(0, N)` 会让超长歌单的后半段凭空消失——艺人作品列表和歌单曲目列表都这么踩过。
- 秒传缓存同样要带语言后缀；命中不到对应语言时，回落到正常下载即可。
- 面向用户的文案都有中英两份，写法是 `isEn ? '...' : '...'`。
- token 刷新、临时文件清理这类定时任务挂在启动流程里，改动时留意别漏掉。

---

## 5. 部署流程

### 5.1 改了哪些文件 → 要做什么

| 改动的文件 | 需要做 |
| :--- | :--- |
| `src/**`、`crates/**`、`src/ui/**` | `cargo build --release` + 重启 `am-hook` |
| `cloud-service.mjs` | 重启 `am-cloud` |
| `tg-bot.mjs` | 重启 `am-tgbot` |
| `changelog.json` | 不用重编、不用重启，服务每次请求都重新读文件 |
| `crates/am-media/**` | 另外重建 wasm 并提交 `src/ui/media.wasm`，否则浏览器端修复不生效 |

### 5.2 部署动作

```bash
# 1. 同步代码（Windows → Linux 会带 CRLF，转一下）
scp <改动的文件> <user>@<host>:/home/<user>/am-hook/<相对路径>
ssh <user>@<host> "cd /home/<user>/am-hook && sed -i 's/\r$//' <改动的文件>"

# 2. 语法自检（Node 文件）
ssh <user>@<host> "cd /home/<user>/am-hook && node --check cloud-service.mjs && node --check tg-bot.mjs"

# 3. 需要重编时
ssh <user>@<host> "cd /home/<user>/am-hook && export PATH=\$HOME/.cargo/bin:\$PATH && cargo build --release"

# 4. 空闲时平滑重启（自带等待，不会打断正在下载的用户）
ssh <user>@<host> "sudo /usr/local/bin/safe-restart all"
# 或单个服务：sudo /usr/local/bin/safe-restart am-hook
```

> 只改 JS 时跳过第 3 步，`cargo build` 要等一分多钟。反过来，改了 `src/ui/**` 却不重编，就是典型的"改了没生效"。

### 5.3 线上验证（改完立刻做）

- Web：用 Playwright 打开站点，手机 + 桌面两个尺寸各看一遍，确认 `scrollWidth === clientWidth`、Console 无 error。
- 双语：中英文各切一次，确认页面没夹带另一种语言。
- 标签：用 `noUpload: true` 发一次转存请求，拿返回的 `audioFilePath` 跑 `ffprobe -show_format`，直接看 `title` / `artist` / `album` / `genre` 的语言对不对。只看 UI 不算验证。

---

## 6. 发版与更新日志

`changelog.json` 是 Web 和 TG Bot 共用的数据来源，服务端接口是 `/api/quota/changelog`。

结构：

```json
{
  "latestVersion": "2.7",
  "date": "YYYY-MM-DD",
  "oneLiner": { "zh": "一句话", "en": "one line" },
  "releases": [
    {
      "version": "2.7",
      "date": "YYYY-MM-DD",
      "title": { "zh": "标题", "en": "Title" },
      "items": { "zh": ["…"], "en": ["…"] }
    }
  ]
}
```

- `releases` 里最新的排最前。Web 端会把第一条渲染成高亮卡片，其余折进"历史版本记录"折叠列表；TG 端的"历史更新记录"按钮直接读这个数组。
- 只写用户能感知的变化（新增能力、修复的坑、行为变化），内部重构不用写。
- `oneLiner` 用在 TG 首次点歌的完成消息末尾，一个版本只提示一次，写短一点。
- 改完 `changelog.json` 推上去就生效，不用重新部署服务。

---

## 7. 提交前自检清单

- [ ] `node --check` 过一遍改动的 JS；Rust 侧至少能编译通过。
- [ ] `git status` 里没有 `.env` / `.key` / 输出文件 / 临时脚本。
- [ ] 改动的 UI 文案中英文都有。
- [ ] 新的临时文件 / 子进程带了清理和超时。
- [ ] 改了 `changelog.json`，且新版本排在最前。
- [ ] 部署后按 §5.3 验过一遍。

---

## 8. 边界与判断题

下面这些改动看着顺手，但踩坑成本很高，建议先跟人类确认：

- **重排 `cloud-service.mjs` 的标签注入顺序**、**动 `stco` 偏移的字节手术**、**碰 wasm / `crates/am-media`**：改完必须跑解码验证（`ffmpeg -f null -`），并在真机播放器上看一眼。
- **配额、权限、`discography` 这类专享开关**：影响所有用户，先问清楚再动。
- **同步上游**：本仓库已和上游 `itouakirai/am-hook` 分叉，结构差异很大，无法 `cherry-pick`，只能按语义移植。移植前先翻 `PROJECT_MEMORY.md` 里的历史结论。
- 其他拿不准的地方，先问一句比猜着改便宜。

---

## 9. 想深入了解

`PROJECT_MEMORY.md`（本地文件、已 gitignore）按"现象 → 根因 → 修复"记录了历次踩坑，动边界情况之前值得翻一翻，通常比从头读代码快。
