# Development skills

These skills guide the coding agent while building The Office. None of them ship in the product.

Source: https://github.com/anthropics/skills at commit `ca45fc496a3436251f191354091d557da31c15b5`.

| Skill | Licence | How we use it |
|---|---|---|
| frontend-design | Apache-2.0 | Governs every screen: design plan, review against the brief, screenshot critique |
| webapp-testing | Apache-2.0 | Playwright screenshot sets for mockup review rounds |
| skill-creator | Apache-2.0 | Authoring each agent's `SKILL.md` flows |
| pdf | Proprietary (Anthropic) | Guidance for the synthetic invoice generator (`tools/synthetic`) |
| xlsx | Proprietary (Anthropic) | Rules for accountant-facing Excel exports |

`pdf` and `xlsx` are git-ignored so they are never redistributed. Re-fetch them with:

```bash
git clone --filter=blob:none --sparse https://github.com/anthropics/skills.git /tmp/anth-skills
cd /tmp/anth-skills && git checkout ca45fc496a3436251f191354091d557da31c15b5
git sparse-checkout set skills/pdf skills/xlsx && cp -r skills/pdf skills/xlsx <repo>/.cursor/skills/
```
