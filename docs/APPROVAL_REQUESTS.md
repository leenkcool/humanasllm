# AI 审批请求样例（15 条）

> 用途：AI Agent 需要**服务器 / 数据库 / 权限 / 密钥 / 环境 / 域名**等资源时，调 `POST /v1/approvals` 向人类提审批。人类批准后提供资源（`provided`），Agent 凭 `approval_no` 回查取回。
> 请求体字段：`resource`（资源名）、`amount`（规格/数量）、`purpose`（用途）、`detail`（补充）、`requester`（申请者）、`project_code`。

## 一、服务器 / 算力
1. 测试服务器
```json
{ "resource": "PostgreSQL 测试服务器", "amount": "2C4G / 50G",
  "purpose": "部署网关生产实例验证", "detail": "需公网可达，监听 0.0.0.0", "requester": "ai-agent" }
```
2. 训练算力
```json
{ "resource": "GPU 训练实例", "amount": "A100×2 / 200G",
  "purpose": "微调私有模型", "detail": "需驱动/CUDA 环境预装", "requester": "ai-agent" }
```

## 二、数据库
3. 生产库只读
```json
{ "resource": "生产数据库只读权限", "amount": "1 账号",
  "purpose": "数据分析与报表", "detail": "仅 SELECT，不落库", "requester": "ai-agent" }
```
4. 测试库
```json
{ "resource": "开发/测试数据库", "amount": "1 实例 / 20G",
  "purpose": "联调与回归测试", "detail": "可随时重建", "requester": "ai-agent" }
```

## 三、云资源 / 网络
5. 公网 IP
```json
{ "resource": "公网 IP + 端口", "amount": "1 个 / 80,443,22",
  "purpose": "站点上线", "detail": "需防火墙放行", "requester": "ai-agent" }
```
6. 对象存储
```json
{ "resource": "对象存储桶", "amount": "100G",
  "purpose": "备份与静态资源", "detail": "需访问密钥", "requester": "ai-agent" }
```

## 四、权限 / 密钥
7. SSH 登录
```json
{ "resource": "SSH 登录权限", "amount": "1 账号",
  "purpose": "部署与运维", "detail": "最小权限，禁止 root", "requester": "ai-agent" }
```
8. API 密钥
```json
{ "resource": "第三方模型 API Key", "amount": "1 个",
  "purpose": "AI 中继测试", "detail": "仅用于指定 provider", "requester": "ai-agent" }
```

## 五、中间件 / 服务
9. 消息队列
```json
{ "resource": "Redis / MQ 实例", "amount": "1 套",
  "purpose": "任务异步处理", "detail": "需持久化", "requester": "ai-agent" }
```
10. 域名
```json
{ "resource": "子域名解析", "amount": "1 个",
  "purpose": "服务访问", "detail": "需绑定到现有证书", "requester": "ai-agent" }
```

## 六、项目 / 环境
11. 建项目
```json
{ "resource": "项目创建申请", "amount": "1 个项目", "type": "project",
  "purpose": "独立项目空间", "detail": "{\"code\":\"data-ops\",\"name\":\"数据运营\"}", "requester": "ai-agent" }
```
12. 预发环境
```json
{ "resource": "预发环境", "amount": "1 套",
  "purpose": "上线前验证", "detail": "与生产同配置", "requester": "ai-agent" }
```

## 七、安全 / 合规
13. 敏感数据访问
```json
{ "resource": "敏感数据导出审批", "amount": "1 次",
  "purpose": "合规审计", "detail": "脱敏后导出", "requester": "ai-agent", "category": "confidential" }
```
14. 渗透测试授权
```json
{ "resource": "授权渗透测试范围", "amount": "1 次",
  "purpose": "安全评估", "detail": "限定 IP/时间窗口", "requester": "ai-agent", "category": "confidential" }
```

## 八、费用 / 成本
15. 云资源费用
```json
{ "resource": "云服务器费用核算", "amount": "本月账单",
  "purpose": "成本对账", "detail": "按项目拆分", "requester": "ai-agent" }
```

---

## 提交方式
```bash
curl -X POST https://humanasllm.anytd.com/v1/approvals \
  -H "Content-Type: application/json" \
  -d '{ "resource": "测试服务器", "amount": "2C4G", "purpose": "验证", "requester": "ai-agent" }'
```
返回 `approval_no` + `status: pending` → 人类在工作台批准（附 `provided` 资源）或驳回 → Agent 回查 `GET /v1/approvals/:approval_no` 取回。
