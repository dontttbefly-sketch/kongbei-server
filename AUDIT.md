# 审计指南

这份文档不解释功能，只回答一个问题：**一笔账从进来到存下来，中间经过了谁，有没有留下副本。**

配合 `server/code/` 里的代码看，每一条都能对上。

---

## 一、一笔账的完整路径

以「用快捷指令记一笔」为例：

```
iPhone 快捷指令
  │  POST /api/accounting   {amount, class, event, date}
  ▼
api/accounting.js            ← 只做转发，不在这个仓库（是 Vercel 的入口壳）
  ▼
server/code/accounting.js    handle()
  │
  ├─ normalizeAmount / normalizeDate        纯校验，不落盘
  ├─ getSettings(60_000)                    读「看板设置」（缓存 1 分钟）
  ├─ createRecord(...)  ────────────┐       写飞书
  │                                  ▼
  │                        server/code/feishu.js  →  open.feishu.cn
  │                        （把账写进你自己的多维表格，返回 recordId）
  │
  ├─ keepAlive(scheduleReminders(...))      后台约提醒，只发时间戳给 QStash
  └─ reply(200, {ok:true, recordId})        返回
```

**关键点：`createRecord` 之后，这个函数里再也没有任何写操作。** 账在内存里存在的那几毫秒，唯一去向是飞书。

## 二、服务端所有的存储写入点

跑这条命令，你会得到**全部 5 个文件、12 处**写入：

```bash
grep -rn "storage()\.set" server/code/ --include=*.js | grep -v test
```

| 文件 | 写的是什么 | 在哪一行 | 含账单吗 |
|---|---|---|---|
| `tenant.js` | 租户记录：加密的应用凭证、到期时间、账本 ID、表格 ID | `saveTenant()` | ❌ |
| `tenant.js` | appId → 用户 ID 的反查索引 | `appIndexKey` | ❌ |
| `saas.js` | 激活码的核销状态 | `codeKey` | ❌ |
| `saas.js` | 一键创建应用的临时会话（设备码） | `REG_KEY` | ❌ |
| `saas.js` | 续费提醒的节流时间戳 | `RENEW_KEY` | ❌ |
| `passkey.js` | 面容 ID 的设备索引 | `pkIndex` | ❌ |

**没有任何一处写入包含金额、类目、备注或日期。**

## 三、有没有偷偷写文件或数据库？

```bash
grep -rn "writeFile\|fs\.write\|INSERT INTO\|mongoose\|sequelize\|pg\.\|mysql" server/code/ --include=*.js
```

预期输出：**只有 `check.js` 里读 `.env` 的那一行**（`fs.readFileSync`，只读不写，是配置自检工具）。服务端是零依赖的，没有装任何数据库驱动——你可以看 `server/package.json`，里面没有依赖。

## 四、凭证是怎么存的（这部分要说清楚）

服务器必须替你拿着飞书应用凭证，否则你的快捷指令没法记帐（浏览器不允许网页直连飞书）。

凭证用 AES-256-GCM 加密后存在 Redis，主密钥来自部署环境变量 `SAAS_SECRET`，不在代码里、不在仓库里。

**这意味着什么，我说实话：** 我是运营方，理论上能解开它、读写你的账本。这是这套架构的边界，不是代码能消除的。我能做的是：不这么做、代码公开让你看得见我没做、以及把最后的开关交给你。

**最后的开关是：到飞书里删掉「空杯记账」这个应用。** 那一刻我手里的一切都失效，而你的账还在你自己的表里，一笔不少。

## 五、和线上版本对得上吗

诚实地说：**代码公开不等于「线上必须跑这份代码」在数学上被证明**。任何自建服务都没法自证这一点，我做的是把作弊的成本抬高：

- 每次发布，`VERSIONS.md` 记一行：看板页脚显示的构建时间 ↔ 本仓库的提交
- 这个仓库由脚本从主仓库单向同步，不手工编辑，避免两边跑偏
- 你可以随时对着 `VERSIONS.md` 检查时间线是否连贯

如果你觉得这还不够，那就回到第四节最后那句：**删掉飞书里的应用，比任何代码都硬。**

---

有任何一处对不上，请发邮件或到答疑群告诉我。对不上就是我的问题，我会改。
