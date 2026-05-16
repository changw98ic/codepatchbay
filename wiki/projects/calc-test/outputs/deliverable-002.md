## Handoff: claude -> codex

- **From**: claude
- **To**: codex
- **Project**: calc-test
- **Phase**: execute
- **Task-Ref**: 004
- **Timestamp**: 2026-05-17T02:30:00Z
- **Plan-Ref**: 004

### Implemented

移除了 `server/routes/review.js` 中从未被填充或引用的死代码：`activeReviewProcesses` Map 声明和 `stopReviewProcess` 函数（共 20 行）。

Review 生命周期确认完全基于请求内路径处理（session status 更新），无需全局进程注册表。`cancelRoute` 通过 `updateSession` 设置 `cancelled` 状态实现取消，`/review/:id/start` 路由使用 `detached: true` + `unref()` 管理子进程生命周期，均不依赖被移除的代码。

### Files Changed
- `server/routes/review.js` — 移除 `activeReviewProcesses` 声明（原 line 30）和 `stopReviewProcess` 函数定义（原 lines 32-50）

### Evidence

**全局零引用验证**:
```
$ grep -r "activeReviewProcesses" --include="*.js" --include="*.mjs" .
(仅 review.js 内部自引用，已移除)

$ grep -r "stopReviewProcess" --include="*.js" --include="*.mjs" .
(仅 review.js 内部定义，已移除)
```

**语法检查**: `node --check server/routes/review.js` — 通过，无错误

**测试结果**:
```
ℹ tests 238
ℹ suites 43
ℹ pass 238
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 40256
```

**关键代码变更**:
```diff
-const activeReviewProcesses = new Map();
-
-function stopReviewProcess(sessionId, signal = "SIGTERM") {
-  const child = activeReviewProcesses.get(sessionId);
-  if (!child) return { killed: false, pid: null };
-
-  const pid = child.pid;
-  try {
-    if (process.platform !== "win32" && pid) {
-      process.kill(-pid, signal);
-    } else {
-      child.kill(signal);
-    }
-    return { killed: true, pid };
-  } catch (err) {
-    if (err?.code !== "ESRCH") throw err;
-    return { killed: false, pid };
-  } finally {
-    activeReviewProcesses.delete(sessionId);
-  }
-}
```

### Unresolved
- 无

### Risks
- 若未来需要"取消正在运行的 review-dispatch 子进程"功能，需重新实现进程注册与信号发送机制。当前 `/review/:id/cancel` 仅更新 session 状态，不终止子进程。

## Next-Action
验证实现是否满足 plan-004.md 中的全部 5 条 Acceptance-Criteria，给出 PASS/FAIL 判定。

## Acceptance-Criteria
- [x] Step 1: review 生命周期路径已确认——成功/错误路径均基于请求内处理，无需外部进程映射
- [x] Step 2: `activeReviewProcesses` 和 `stopReviewProcess` 已完全移除，无残留引用
- [x] Step 3: 清理行为通过 session status update 实现，不依赖全局 registry
- [x] Step 4: 无暗示"可取消进程注册"的残留注释（原文无此类注释）
- [x] Step 5: 安全核对清单已在 Evidence 中体现——全局搜索确认零外部引用
- [x] 代码无安全隐患
- [x] 无遗漏的边界情况
