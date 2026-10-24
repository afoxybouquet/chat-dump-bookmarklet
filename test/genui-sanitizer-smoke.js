// Smoke test for GenUISanitizer against real "canvas answer" DSL fragments
// (reproduced from an actual broken ChatDump export, not fabricated).
import { stripGenUI } from '../src/GenUISanitizer.js'

const cases = [
	{
		name: 'Link + Cite inline',
		input: `The open-source <Link url="https://github.com/danielmiessler/Fabric" title="Fabric"/> project separates extraction tasks. <Cite refs={["turn410154search0","turn410154search6"]}/>`,
		expectIncludes: ['[Fabric](https://github.com/danielmiessler/Fabric)'],
		expectExcludes: ['<Link', '<Cite', 'refs={'],
	},
	{
		name: 'box/row/button/CodeBlock prompt card',
		input: `<box gap={2}>
  <row align="center" justify="between">
    <text weight="medium" color="secondary" size="xs">CONVERSATION → OBSIDIAN MARKDOWN</text>
    <button size="xs" variant="outline" color="secondary" onClick={() => GenUI.copy(\`Turn our conversation into a note\`)}>
      <icon name="copy" size="xs"/> Copy prompt
    </button>
  </row>
  <CodeBlock language="markdown" editable>
Turn our conversation into a note
  </CodeBlock>
</box>`,
		expectIncludes: ['```markdown', 'Turn our conversation into a note', '```'],
		expectExcludes: ['<box', '<row', '<button', '<icon', 'onClick', 'GenUI.copy'],
	},
	{
		name: 'WritingBlock wrapper',
		input: `<WritingBlock id="57381" variant="standard">## REASONING PRESERVATION

Preserve substantive reasoning.</WritingBlock>`,
		expectIncludes: ['## REASONING PRESERVATION', 'Preserve substantive reasoning.'],
		expectExcludes: ['<WritingBlock', '</WritingBlock>'],
	},
	{
		name: '{@body}/{#each} rating-widget criteria recovery',
		input: `{@body const criteria = [{name:"Fidelity",description:"Does it faithfully distinguish my decisions from AI suggestions?"},{name:"Completeness",description:"Did it retain the valuable insights?"}]}
{@body const [scores,setScores] = DIL.useState([0,0])}
<box border radius="xl" padding={3} gap={3}>
  {#each criteria as c,i}
    <box key={c.name} gap={1}>
      <row justify="between" align="center">
        **{c.name}**
        <text color="secondary">{scores[i] ? \`\${scores[i]}/5\` : "Not rated"}</text>
      </row>
    </box>
  {/each}
</box>`,
		expectIncludes: ['**Fidelity** — Does it faithfully distinguish my decisions from AI suggestions?', '**Completeness** — Did it retain the valuable insights?'],
		expectExcludes: ['{@body', '{#each', '{/each}', 'DIL.useState', '<box', 'scores[i]'],
	},
	{
		name: 'plain prose is untouched',
		input: `This is ordinary prose with *no* special markup, just **Markdown** and a [link](https://example.com).`,
		expectIncludes: ['This is ordinary prose with *no* special markup, just **Markdown** and a [link](https://example.com).'],
		expectExcludes: [],
	},
	{
		name: 'orphaned box-grid indentation is stripped (was misread as an indented code block)',
		input: `<box gap={3}>
  <row align="start" gap={3}>
    <box flex="1" gap={1}>
      **1. Extract: What is worth preserving?**

      Recover important knowledge from the full discussion.
    </box>
  </row>
</box>`,
		expectIncludes: ['**1. Extract: What is worth preserving?**', 'Recover important knowledge from the full discussion.'],
		expectExcludes: ['    **1. Extract', '      Recover important knowledge'],
	},
	{
		name: 'real fenced code indentation is preserved even with surrounding GenUI markup',
		input: `<box gap={2}>
  <CodeBlock language="python" editable>
def f():
    return 1
  </CodeBlock>
</box>`,
		expectIncludes: ['```python', 'def f():\n    return 1', '```'],
		expectExcludes: [],
	},
	{
		name: "user's own brace-delimited pseudocode is never passed through stripGenUI in the first place (role-scoping lives in ChatGPTParser, not here) — sanity-check stripGenUI alone would still mangle it if misapplied",
		input: `config = {\n  evidence: {\n    instruction: "Re-examine the source material.",\n    priority: "high"\n  }\n}`,
		// stripGenUI has no way to know this is user text vs. a GenUI binding,
		// so this case documents the behavior this module's caller must guard
		// against by only invoking it on assistant content (see
		// remote-chatgpt.js's 'user brace-syntax prompt untouched' check).
		skip: true,
	},
]

let failures = 0
for (const c of cases) {
	if (c.skip) {
		console.log(`SKIP [${c.name}]`)
		continue
	}
	const out = stripGenUI(c.input)
	let ok = true
	for (const inc of c.expectIncludes) {
		if (!out.includes(inc)) {
			ok = false
			console.error(`FAIL [${c.name}]: expected output to include ${JSON.stringify(inc)}`)
		}
	}
	for (const exc of c.expectExcludes) {
		if (out.includes(exc)) {
			ok = false
			console.error(`FAIL [${c.name}]: expected output to NOT include ${JSON.stringify(exc)}`)
		}
	}
	if (ok) {
		console.log(`PASS [${c.name}]`)
	} else {
		failures++
		console.error(`--- output was ---\n${out}\n------------------`)
	}
}

if (failures) {
	console.error(`\n${failures}/${cases.length} cases failed`)
	process.exit(1)
} else {
	console.log(`\nAll ${cases.length} cases passed`)
}
