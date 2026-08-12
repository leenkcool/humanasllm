/**
 * 推 GitHub 前敏感检查
 * 扫描 git 跟踪文件：数据库密码 / API Key / 真实密钥。
 * 通过（exit 0）才应推送公开仓库。用法：npm run check:secret
 * 排除：.env（不入库）、.env.example（占位）、.md（文案）、node_modules、data（运行数据）
 */
const { execSync } = require('child_process');
const fs = require('fs');

const skip = (f) => !f
  || /\.env($|\.example)/.test(f)          // 配置占位
  || /\.md$/.test(f)                        // 文案（可含示例）
  || /node_modules/.test(f)
  || /^data\//.test(f)                      // 运行数据（gitignore）
  || /\.codegraph\//.test(f);

// 敏感模式：已知密码 / 长 API key
const RE = [/goodgirl/i, /sk-[A-Za-z0-9]{16,}/];

const files = execSync('git ls-files', { encoding: 'utf8' })
  .split('\n')
  .filter((f) => !skip(f));

const bad = [];
for (const f of files) {
  const c = fs.readFileSync(f, 'utf8');
  if (RE.some((r) => r.test(c))) bad.push(f);
}

if (bad.length) {
  console.error('❌ 发现敏感信息，禁止推送公开仓库：');
  bad.forEach((f) => console.error('   - ' + f));
  process.exit(1);
}
console.log(`✅ 敏感检查通过（${files.length} 个文件），可安全推 GitHub`);
