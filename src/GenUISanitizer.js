/**
 * Strips/converts OpenAI's "canvas answer" generative-UI markup.
 *
 * Newer ChatGPT responses can embed a private JSX/Svelte-like component DSL
 * directly in content.parts[0] for content_type "text" turns (citation
 * chips, link cards, copy buttons, collapsible writing blocks, interactive
 * rating widgets, etc). The chatgpt.com frontend renders this client-side;
 * the backend API returns the raw DSL string verbatim. Previously ChatDump
 * passed that string straight through, so plain prose exported fine while
 * any paragraph touching one of these widgets came out as literal
 * `<Cite .../>`, `<box>`, `{#each}` tag soup.
 *
 * This module has no knowledge of the DSL's grammar (it's undocumented and
 * can change at any time) — it applies a handful of known, semantically
 * meaningful conversions, then falls back to generically unwrapping or
 * stripping anything that still looks like a component tag or a template
 * expression, so unknown future components degrade to prose instead of to
 * garbage.
 */

// --- 1. Known components with a clean Markdown equivalent -----------------

// <Link url="https://x" title="Label"/>  ->  [Label](https://x)
function convertLinks(text) {
	return text.replace(/<Link\s+url="([^"]*)"\s+title="([^"]*)"\s*\/>/g, (_m, url, title) => `[${title}](${url})`)
}

// <Cite ref="..."/> / <Cite refs={[...]}/>  ->  dropped (internal citation ids, not resolvable)
function stripCites(text) {
	return text.replace(/<Cite\s+[^>]*\/>/g, '')
}

// <icon name="..." size="..."/>  ->  dropped (decorative, no text equivalent)
function stripIcons(text) {
	return text.replace(/<icon\s+[^>]*\/>/g, '')
}

// <button ...>...</button>  ->  dropped entirely, including its label (pure
// UI chrome: "Copy prompt", "Copy", score pickers — never content worth keeping)
function stripButtons(text) {
	return text.replace(/<button\b[^>]*>[\s\S]*?<\/button>/g, '')
}

// <CodeBlock language="md" editable>...</CodeBlock>  ->  fenced code block
function convertCodeBlocks(text) {
	return text.replace(/<CodeBlock\s+language="([^"]*)"[^>]*>([\s\S]*?)<\/CodeBlock>/g, (_m, lang, body) => {
		const content = body.replace(/^\n/, '').replace(/\n$/, '')
		const marks = content.includes('```') ? '````' : '```'
		return `${marks}${lang}\n${content}\n${marks}`
	})
}

// --- 2. Generic container unwrapping --------------------------------------
// box / row / divider / caption / title / text / WritingBlock: these are pure
// layout/typography wrappers with no Markdown equivalent. Keep the inner
// content, drop the tag and its props (one regex covers open, close, and
// self-closing forms: a self-closer still ends in `/>`, which `[^>]*>`
// already matches).
const CONTAINER_RE = /<\/?(?:box|row|divider|caption|title|text|WritingBlock)\b[^>]*>/g

function unwrapContainers(text) {
	return text.replace(CONTAINER_RE, '')
}

// --- 3. {#each}/{@body} template blocks -----------------------------------
// These bind to live component state (e.g. an interactive 1-5 rating grid)
// and have no static Markdown rendering. Best-effort: if a `{@body const
// NAME = [ {...}, ... ]}` array-of-objects literal immediately precedes a
// matching `{#each NAME as item}`, recover its entries as a bullet list
// (common pattern: rubric/criteria lists feeding a scoring widget). Anything
// that doesn't match this shape is simply dropped, not emitted as raw code.

function tryParseObjectArrayLiteral(src) {
	// Turns a loose JS object-array literal (unquoted keys, single/double
	// quoted string values) into real JSON by quoting bare keys. Deliberately
	// conservative: bails (returns null) on anything it isn't confident about
	// rather than risk corrupting output.
	try {
		const jsonish = src
			.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":') // bare keys -> quoted
			.replace(/'([^'\\]*)'/g, '"$1"') // single-quoted strings -> double
			.replace(/,(\s*[\]}])/g, '$1') // trailing commas
		const parsed = JSON.parse(jsonish)
		return Array.isArray(parsed) ? parsed : null
	} catch {
		return null
	}
}

function convertEachBlocks(text) {
	const bodyDecl = /\{@body\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(\[[\s\S]*?\])\}\s*/g
	const literals = new Map()
	let out = text.replace(bodyDecl, (_m, name, arrLiteral) => {
		const parsed = tryParseObjectArrayLiteral(arrLiteral)
		if (parsed) literals.set(name, parsed)
		return '' // drop the declaration itself either way
	})

	out = out.replace(/\{#each\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+[^}]*\}([\s\S]*?)\{\/each\}/g, (_m, name) => {
		const items = literals.get(name)
		if (!items || !items.length) return ''
		return (
			'\n\n' +
			items
				.map((item) => {
					if (item && typeof item === 'object') {
						const label = item.name || item.title || ''
						const desc = item.description || item.desc || ''
						if (label || desc) return `- **${label}**${label && desc ? ' — ' : ''}${desc}`
					}
					return `- ${String(item)}`
				})
				.join('\n') +
			'\n\n'
		)
	})

	return out
}

// --- 4. Remaining leftovers --------------------------------------------
// Any {...} expression still standing is a live binding (onClick handlers,
// scores[i], etc.) with no static text to show — drop it. Any still-standing
// <PascalCase ...> / <lowercase-custom ...> tag is an unrecognized component:
// unwrap paired tags (keep inner text), drop self-closing ones.
function stripLeftoverExpressions(text) {
	return text.replace(/\{[^{}]*\}/g, '')
}

function stripUnknownTags(text) {
	let out = text
	// self-closing unknown tags: <Foo a="b" />
	out = out.replace(/<[A-Za-z][\w.-]*(?:\s+[^<>]*)?\/>/g, '')
	// paired unknown tags: unwrap, keep inner content
	out = out.replace(/<\/?[A-Za-z][\w.-]*(?:\s+[^<>]*)?>/g, '')
	return out
}

// --- 5. Leftover JSX indentation -----------------------------------------
// Unwrapping box/row/text/caption/title/WritingBlock removes the tags but
// not the indentation whitespace those lines had as nested JSX source. A
// line left with >=4 leading spaces/tabs is then misread by Markdown as an
// "indented code block" (a monospaced, bordered box in Obsidian). Strip
// that leftover indentation, but never touch text inside a REAL fenced code
// block (``` / ~~~), since convertCodeBlocks() already emitted those and
// their content must survive byte-for-byte.
function stripStrayIndentation(text) {
	let inFence = false
	return text
		.split('\n')
		.map((line) => {
			const isFence = /^\s*(`{3,}|~{3,})/.test(line)
			if (isFence) inFence = !inFence
			return isFence || inFence ? line : line.replace(/^[ 	]{4,}/, '')
		})
		.join('\n')
}

function collapseBlankLines(text) {
	return text
		.split('\n')
		.map((l) => l.replace(/[ \t]+$/, ''))
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
}

/**
 * Runs the full sanitization pipeline on a single content.parts string.
 * Safe to call on plain prose: every step is a no-op when its pattern isn't
 * present, so ordinary turns pass through unchanged.
 * @param {string} text
 * @returns {string}
 */
export function stripGenUI(text) {
	if (typeof text !== 'string' || !text.includes('<') && !text.includes('{')) {
		return text // fast path: nothing that could be DSL markup
	}
	let out = text
	out = convertCodeBlocks(out) // before generic unwrap (its content must survive verbatim)
	out = convertLinks(out)
	out = stripCites(out)
	out = stripIcons(out)
	out = stripButtons(out) // before container unwrap (drops label text on purpose)
	out = convertEachBlocks(out) // before generic {...} stripping consumes its braces
	out = unwrapContainers(out)
	out = stripLeftoverExpressions(out)
	out = stripUnknownTags(out)
	out = stripStrayIndentation(out)
	out = collapseBlankLines(out)
	return out
}
