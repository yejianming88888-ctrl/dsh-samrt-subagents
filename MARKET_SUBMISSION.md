# dsh-market submission

Submit this plugin to [`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) after the GitHub repository has been renamed and meets the directory eligibility requirements.

Create this file in the directory repository:

`data/plugins/yejianming88888-ctrl__dsh-samrt-subagent.yml`

```yaml
url: https://github.com/yejianming88888-ctrl/dsh-samrt-subagent
name: yejianming88888-ctrl/dsh-samrt-subagent
category: workflow
description:
  en: Intelligent sub-agent orchestration for DeepSeek Harness, with model discovery, routing, planning, and parallel delegation.
  zh: 面向 DeepSeek Harness 的智能子 Agent 编排插件，支持模型发现、智能路由、任务规划和并行委派。
```

Then run in the directory repository:

```sh
npm ci
node scripts/generate-readme.mjs
```

Commit the YAML file and regenerated `README.md`/`README.zh.md`, then open a pull request.

## Pre-submission checklist

- [x] Rename the GitHub repository to `dsh-samrt-subagent`.
- [ ] Update the local `origin` URL after the repository rename.
- [ ] Confirm `dsh plugin --profile web add dsh-samrt-subagent` installs successfully.
- [ ] Publish `dsh-samrt-subagent` to npm, or provide an installable GitHub source/release.
- [ ] Keep the public repository online for at least one day.
- [ ] Reach the directory requirement of at least 10 meaningful commits; do not manufacture empty commits.
- [ ] Run `pnpm test` and inspect `npm pack --dry-run`.
- [ ] Add screenshots to the GitHub README if desired; dsh-market can extract GitHub-hosted README images.
