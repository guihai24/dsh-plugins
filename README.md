# dsh-plugins

Community [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin bundles by
[@huaguihai](https://github.com/huaguihai), plus the format-1 plugin market index that lists them.

## Available plugins

| Plugin | Tool | Backend |
|---|---|---|
| [`packages/dsh-subagent-antigravity-cli`](packages/dsh-subagent-antigravity-cli) | `subagent_antigravity` | Google Antigravity CLI (`agy`) |
| [`packages/dsh-subagent-workbuddy`](packages/dsh-subagent-workbuddy) | `subagent_workbuddy` | WorkBuddy's bundled CodeBuddy CLI (`codebuddy`) |

Both are one-shot subagent providers: the parent Agent delegates a self-contained text task, a
fresh CLI process runs it in the child workspace, and only the final answer or a safe failure
diagnostic returns. Authentication and settings stay native to each CLI.

## Install from the market

Add this index source to the DeepSeek Harness plugin page:

```
插件 → 实验性插件 → 更多 → 自定义插件市场 → 发现 → 添加索引源
https://raw.githubusercontent.com/huaguihai/dsh-plugins/main/index.json
```

Then search for "Antigravity" or "WorkBuddy" and install.

## Install from npm

```bash
npm i -g dsh-subagent-antigravity-cli dsh-subagent-workbuddy
# or install into a profile:
dsh plugin --profile <profile> add dsh-subagent-workbuddy
```

## Install without the market

```bash
dsh plugin --profile <profile> add github:huaguihai/dsh-plugins#path:packages/dsh-subagent-workbuddy
```

or install the exact commit the index pins.

## Layout

```
index.json                     format-1 plugin market index
packages/<name>/               one bundle per directory
  package.json                 npm manifest + dsh.bundle.patch
  cordis.patch.yml             profile layer: provider row + tool row
  lib/index.js                 provider implementation
  locale/{zh,en}.json          plugin page metadata
  icon.svg
```

## License

MIT
