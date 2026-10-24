/**
 * Verifies the ChatGPT remote (API-based) extraction path with a mocked
 * same-origin fetch: session token retrieval, active-branch linearization
 * from the conversation tree (branched mapping), merging of consecutive
 * assistant nodes, code fencing, attachments, hidden-message exclusion.
 */
import { JSDOM } from 'jsdom'

const CONV_ID = '11111111-2222-3333-4444-555555555555'

const dom = new JSDOM('<body></body>', { url: `https://chatgpt.com/c/${CONV_ID}` })
global.window = dom.window
global.document = dom.window.document
global.NodeFilter = dom.window.NodeFilter
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true })

const msg = (id, parent, children, message) => ({ id, parent, children, message })
const conversation = {
	title: 'GPT test conversation',
	current_node: 'n8',
	mapping: {
		root: msg('root', null, ['n1'], null),
		n1: msg('n1', 'root', ['n2', 'n2-abandoned'], {
			author: { role: 'user' },
			content: { content_type: 'text', parts: ['First question'] },
			metadata: { attachments: [{ name: 'data.csv' }] },
		}),
		// abandoned branch: must NOT appear in the export
		'n2-abandoned': msg('n2-abandoned', 'n1', [], {
			author: { role: 'assistant' },
			content: { content_type: 'text', parts: ['OLD ANSWER from abandoned branch'] },
		}),
		n2: msg('n2', 'n1', ['n3'], {
			author: { role: 'assistant' },
			content: { content_type: 'text', parts: ['Answer part one.'] },
		}),
		n3: msg('n3', 'n2', ['n4'], {
			author: { role: 'assistant' },
			content: { content_type: 'code', language: 'python', text: 'print(42)' },
		}),
		n4: msg('n4', 'n3', ['n5'], {
			author: { role: 'system' },
			content: { content_type: 'text', parts: ['system noise'] },
			metadata: { is_visually_hidden_from_conversation: true },
		}),
		n5: msg('n5', 'n4', ['n6'], {
			author: { role: 'user' },
			content: { content_type: 'text', parts: ['Second question'] },
		}),
		n6: msg('n6', 'n5', ['n7'], {
			author: { role: 'assistant' },
			content: { content_type: 'text', parts: ['Second answer'] },
		}),
		// user prompt using brace-heavy pseudocode syntax (Ruby-style hash):
		// must survive byte-for-byte. GenUI sanitization must never run on
		// user turns, only assistant turns.
		n7: msg('n7', 'n6', ['n8'], {
			author: { role: 'user' },
			content: {
				content_type: 'text',
				parts: ['config = {\n  evidence: {\n    instruction: "Re-examine the source material.",\n    priority: "high"\n  }\n}'],
			},
		}),
		// assistant canvas-answer turn: GenUI DSL must still be sanitized
		n8: msg('n8', 'n7', [], {
			author: { role: 'assistant' },
			content: {
				content_type: 'text',
				parts: ['<box gap={2}>\n        **Indented inside a box**\n      </box>\n<Cite ref="x"/>'],
			},
		}),
	},
}

const routes = {
	'/api/auth/session': { accessToken: 'tok-123' },
	[`/backend-api/conversation/${CONV_ID}`]: conversation,
}
let bearerSeen = null
global.fetch = async (path, opts) => {
	if (path.startsWith('/backend-api/')) {
		bearerSeen = opts && opts.headers && opts.headers.authorization
	}
	if (!routes[path]) return { ok: false, status: 404 }
	return { ok: true, status: 200, json: async () => routes[path] }
}
dom.window.fetch = global.fetch

const { default: ChatGPTParser } = await import('../src/Parsers/ChatGPTParser.js')
const { processConversations } = await import('../src/ConversationProcessor.js')
const { formatAsMarkdown } = await import('../src/OutputFormatter.js')

const remote = await ChatGPTParser.parseRemote()
const checks = []
const check = (label, cond) => {
	checks.push([label, cond])
	console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`)
}

check('bearer token sent', bearerSeen === 'Bearer tok-123')
check('6 items (3 prompts + 3 merged responses)', remote && remote.items.length === 6)
check('title from API', remote.title === 'GPT test conversation')

const md = formatAsMarkdown(processConversations(remote.items), remote.title)
check('assistant nodes merged into one response', md.includes('Answer part one.') && md.includes('```python\nprint(42)\n```'))
check('abandoned branch excluded', !md.includes('OLD ANSWER'))
check('hidden system message excluded', !md.includes('system noise'))
check('attachment listed', md.includes('data.csv'))
check('second turn present', md.includes('Second question') && md.includes('Second answer'))
check(
	'user brace-syntax prompt untouched by GenUI sanitizer',
	md.includes('evidence: {') && md.includes('instruction: "Re-examine the source material."') && md.includes('priority: "high"'),
)
check('assistant GenUI box unwrapped and de-indented', md.includes('**Indented inside a box**') && !md.includes('      **Indented inside a box**'))
check('assistant GenUI Cite/box tags stripped', !md.includes('<box') && !md.includes('<Cite'))

if (checks.some(([, cond]) => !cond)) {
	process.exit(1)
}
console.log('remote-chatgpt: all checks passed')
