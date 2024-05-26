
import {
	createConnection, TextDocuments, ProposedFeatures, TextDocumentSyncKind, WorkspaceFolder, DidChangeConfigurationNotification, integer, Range, Diagnostic, DiagnosticRelatedInformation, CompletionItem, CompletionItemKind, Location, DiagnosticSeverity, SymbolKind, Position, DocumentSymbol, TextEdit, InlayHint, InlayHintKind,
} from 'vscode-languageserver/node'

import {
	TextDocument
} from 'vscode-languageserver-textdocument'

import { URI } from 'vscode-uri'
import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import path = require('path')
import fs = require('fs')
import os = require('os')
import { DasSettings, defaultSettings, documentSettings } from './dasSettings'
import { AtToRange, AtToUri, BaseType, Brackets, CompletionAt, DasToken, Delimiter, EXTENSION_FN_SORT, FIELD_SORT, FixedValidationResult, OPERATOR_SORT, PROPERTY_PREFIX, PROPERTY_SORT, TokenKind, ValidationResult, addValidLocation, baseTypeIsEnum, describeToken, enumDetail, enumDocs, enumValueDetail, enumValueDocs, fixPropertyName, funcArgDetail, funcArgDocs, funcDetail, funcDocs, getParentStruct, globalDetail, globalDocs, isPositionLess, isPositionLessOrEqual, isRangeEqual, isRangeLengthZero, isRangeLess, isRangeZeroEmpty, isSpaceChar, isValidIdChar, posInRange, primitiveBaseType, rangeCenter, rangeLength, structDetail, structDocs, structFieldDetail, structFieldDocs, typeDeclCompletion, typeDeclDefinition, typeDeclDetail, typeDeclDocs, typeDeclFieldDetail, typeDeclFieldDocs, typeDeclIter, typedefDetail, typedefDocs } from './completion'
import { shortTdk } from './completion'
import { closedBracketPos } from './completion'


// Creates the LSP connection
const connection = createConnection(ProposedFeatures.all)

// Create a manager for open text documents
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument)

const validatingResults: Map<string/*uri*/, FixedValidationResult> = new Map()

// The workspace folder this server is operating on
let workspaceFolders: WorkspaceFolder[] | null

let hasConfigurationCapability = false
let hasWorkspaceFolderCapability = false
let hasDiagnosticRelatedInformationCapability = false


function debugWsFolders() {
	return workspaceFolders ? workspaceFolders.map(f => f.name).join(', ') : ''
}

// did change content will be called on open and on change
// documents.onDidOpen((event) => {
// 	console.log(`[Server(${process.pid}) ${debugWsFolders()}] Document opened: ${event.document.uri}`)
// 	validateTextDocument(event.document)
// })

documents.onDidChangeContent((event) => {
	console.log(`[Server(${process.pid}) ${debugWsFolders()}] Document changed: ${event.document.uri}`)
	updateDocumentData(event.document)
})

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri)
	const prevProcess = validatingProcesses.get(e.document.uri)
	if (prevProcess != null) {
		prevProcess.process?.kill()
		console.log('killed process for', e.document.uri)
		validatingProcesses.delete(e.document.uri)
	}
	validatingResults.delete(e.document.uri) // TODO: remove only tokens?
	connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] })
})

documents.listen(connection)

connection.onInitialize((params) => {
	workspaceFolders = params.workspaceFolders
	console.log(`[Server(${process.pid}) ${debugWsFolders()}] Started and initialize received`)

	const capabilities = params.capabilities

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	)
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	)
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	)

	return {
		capabilities: {
			completionProvider: {
				resolveProvider: false,
				triggerCharacters: ['.', ' ', '>', ':'],
			},
			hoverProvider: true,
			definitionProvider: true,
			// declarationProvider: true,
			typeDefinitionProvider: true,
			documentSymbolProvider: true,
			referencesProvider: true,
			inlayHintProvider: {
				resolveProvider: false,
			},
			// colorProvider: true,
			// documentHighlightProvider : true, // TODO: implement
			// workspace: {
			// fileOperations:{}
			// workspaceFolders: {}
			// },
			workspace: {
				workspaceFolders: {
					supported: true,
					changeNotifications: true,
				}
			},
			textDocumentSync: {
				openClose: true,
				change: TextDocumentSyncKind.Incremental,
				save: {
					includeText: true,
				},
			},
		}
	}
})


interface CallChain {
	obj: string
	objRange: Range
	tokens: DasToken[]
	tdks: Set<string>
	delimiter: Delimiter
	delimiterRange: Range
	brackets: Brackets
}

function findCallChain(doc: TextDocument, fileData: FixedValidationResult, pos: Position, forAutocompletion: boolean): CallChain[] {
	return findCallChain_(doc, fileData, pos, forAutocompletion, 0)
}
function findCallChain_(doc: TextDocument, fileData: FixedValidationResult, pos: Position, forAutocompletion: boolean, recursion: number): CallChain[] {
	if (recursion > 10) {
		return []
	}
	/// find chain of fields access - foo.key or foo().key  ... etc
	/// support sequences: foo.key.key2.key3
	/// also support function calls and array/table access: foo().key, foo[0].key, foo().key[0]
	const line = doc.getText(Range.create(pos.line, 0, pos.line, pos.character))
	let key = ''
	let keyRange: Range
	let i = line.length - 1
	let tokens: DasToken[] = []
	let del = Delimiter.None
	// if (!forAutocompletion) {
	// lets try to find token under cursor
	const cursorTokens = findTokensUnderCursor(doc, fileData, pos)
	for (const cursorTok of cursorTokens) {
		tokens.push(cursorTok)
		key = cursorTok.name
		keyRange = cursorTok._range
		i = doc.offsetAt(cursorTok._range.start) - doc.offsetAt(Position.create(pos.line, 0)) - 1
	}
	// }

	// if (forAutocompletion || tokens.length === 0) {
	if (tokens.length === 0) {
		// auto completion or token not found - find it manually
		for (; i >= 0; i--) {
			const ch = line[i]
			if (isSpaceChar(ch)) {
				if (key.length === 0) {
					del = Delimiter.Space
					continue
				}
				break
			}
			if (isValidIdChar(ch))
				key = ch + key
			else
				break
		}
		if (!forAutocompletion) {
			// search the rest of the key
			const text = doc.getText(Range.create(pos.line, pos.character, pos.line, pos.character + 100))
			for (let j = 0; j < text.length; j++) {
				const ch = text[j]
				if (isValidIdChar(ch))
					key += ch
				else
					break
			}
		}
		keyRange = Range.create(pos.line, i + 1, pos.line, i + 1 + key.length)
	}

	if (del === Delimiter.Space && (key == 'as' || key == 'is')) {
		// skip 'as' 'is' '?as' in case when space is delimiter
		// `foo as |` - converts to ["foo", ""], not to ["foo", "as"]
		// `?as` will be also skipped
		i += key.length
		key = ''
		keyRange = Range.create(pos.line, i + 1, pos.line, i + 1)
	}
	else {
		// skip spaces
		for (; i >= 0; i--) {
			const ch = line[i]
			if (!isSpaceChar(ch))
				break
		}
	}
	const keyData: CallChain = { obj: key, objRange: keyRange, tokens: tokens, tdks: new Set(tokens.map(it => it.tdk)), delimiter: del, brackets: Brackets.None, delimiterRange: Range.create(0, 0, 0, 0) }

	let res: CallChain[] = [keyData]
	while (i > 0) {
		del = Delimiter.None
		let delimiterRange = Range.create(pos.line, i, pos.line, i)
		// '.' ' ' '?.' '->' 'as' 'is' '?as' '|>'

		// space can be delimiter only when chain is just started
		if (line[i] === ' ') {
			i -= 1
			del = Delimiter.Space
		}
		else if (i > 0 && line[i] === '.' && line[i - 1] === '?') {
			i -= 2
			del = Delimiter.QuestionDot
		}
		else if (line[i] === '.') {
			i -= 1
			del = Delimiter.Dot
		}
		else if (i > 0 && line[i] === '>' && line[i - 1] === '-') {
			i -= 2
			del = Delimiter.Arrow
		}
		else if (i > 1 && line[i] === 's' && line[i - 1] === 'a' && line[i - 2] === '?') {
			i -= 3
			del = Delimiter.QuestionAs
		}
		else if (i > 0 && line[i] === 's' && line[i - 1] === 'a') {
			i -= 2
			del = Delimiter.As
		}
		else if (i > 0 && line[i] === 's' && line[i - 1] === 'i') {
			i -= 2
			del = Delimiter.Is
		}
		else if (i > 0 && line[i] === '>' && line[i - 1] === '|') {
			i -= 2
			del = Delimiter.Pipe
		}
		else if (i > 0 && line[i] === ':' && line[i - 1] === ':') {
			i -= 2
			del = Delimiter.ColonColon
		}
		delimiterRange.start.character = i
		if (del === Delimiter.None)
			break
		// skip spaces
		for (; i >= 0; i--) {
			const ch = line[i]
			if (!isSpaceChar(ch))
				break
		}
		let tokenEnd = i + 1 // token + brackets

		let brackets = Brackets.None
		if (i >= 0) {
			brackets = line[i] === ')' ? Brackets.Round : line[i] === ']' ? Brackets.Square : Brackets.None
			if (brackets !== Brackets.None) {
				let numO = 0 // ( )
				let numE = 0 // { }
				let numD = 0 // [ ]
				for (; i >= 0; i--) {
					const ch = line[i]
					if (ch === ')')
						numO++
					else if (ch === '(')
						numO--
					else if (ch === ']')
						numD++
					else if (ch === '[')
						numD--
					else if (ch === '}')
						numE++
					else if (ch === '{')
						numE--
					if ((ch == '(' || ch == '[' || ch == '{') && numO == 0 && numE == 0 && numD == 0) {
						i-- // skip last bracket
						break
					}
				}

				if (brackets == Brackets.Square && i >= 0 && line[i] === '?') {
					// ?[] case, skip '?'
					brackets = Brackets.QuestionSquare
					i--
				}

				// skip spaces
				for (; i >= 0; i--) {
					const ch = line[i]
					if (!isSpaceChar(ch))
						break
				}
			}
		}

		let obj = ''
		for (; i >= 0; i--) {
			const ch = line[i]
			if (isValidIdChar(ch))
				obj = ch + obj
			else
				break
		}
		if (obj.length === 0) { break }
		if (del === Delimiter.Space && i >= 0 && isSpaceChar(line[i]) && (obj == 'as' || obj == 'is' || obj == '?as')) {
			// skip 'as' 'is' '?as' in case when space is delimiter and next char is space
			i += obj.length // move back to beginning of the word
			continue
		}

		// space delimiter can be only at the beginning of the chain
		if (del == Delimiter.Space && res.length >= 2)
			break
		const objRange = Range.create(pos.line, i + 1, pos.line, tokenEnd)
		res.unshift({ obj: obj, objRange: objRange, tokens: [], tdks: new Set(), delimiter: del, brackets: brackets, delimiterRange: delimiterRange })
	}

	resolveChainTdks(doc, fileData, res, forAutocompletion, recursion)
	return res
}

function resolveChainTdks(doc: TextDocument, fileData: FixedValidationResult, callChain: CallChain[], forAutocompletion: boolean, recursion = 0): void {
	if (callChain.length === 0)
		return
	const last = callChain[callChain.length - 1]
	if (!forAutocompletion && last.tokens.length > 0) {
		return
	}

	let prevTdks: Set<string>
	let prevBrackets: Brackets = Brackets.None
	let prevDelimiter: Delimiter = Delimiter.None
	let prevDelimiterRange: Range
	var idx = 0
	while (idx < callChain.length) {
		if (idx > 0) {
			prevBrackets = callChain[idx - 1].brackets
			prevDelimiter = callChain[idx - 1].delimiter
			prevDelimiterRange = callChain[idx - 1].delimiterRange
		}
		const call = callChain[idx]
		idx++
		// maybe already exists token
		if (call.tokens.length > 0) {
			call.tdks = new Set(call.tokens.map(it => it.tdk))
			prevTdks = call.tdks
			continue
		}
		// don't change here anything, it works fine
		const searchPos = call.delimiter.length > 1 && prevDelimiterRange ? rangeCenter(prevDelimiterRange) : call.objRange.start
		const cursorTokens = findTokensUnderCursor(doc, fileData, searchPos)
		if (cursorTokens.length > 0) {
			for (const cursorTok of cursorTokens) {
				call.tokens.push(cursorTok)
				call.tdks.add(cursorTok.tdk)
			}
			if (call.tokens.length > 0) {
				prevTdks = call.tdks
				continue
			}
		}
		if (idx == 1) {
			const tokens = call.tokens.length > 0 ? call.tokens : findNearestTokensAt(doc, fileData, call, recursion)
			if (tokens.length > 0) {
				call.tokens = tokens
				call.tdks = new Set(tokens.map(it => it.tdk))
				prevTdks = call.tdks
				continue
			}
		}
		if (call.obj.length > 0) {
			if (prevTdks && prevTdks.size > 0) {
				// resolve tdk for type decls
				for (const prevTdk of prevTdks) {
					let typeDeclData = fileData.completion.typeDecls.find(td => td.tdk === prevTdk)
					if (typeDeclData != null) {
						var next: CompletionItem[] = []
						const nextTdks = typeDeclCompletion(typeDeclData, fileData.completion, prevDelimiter, prevBrackets, next)
						// if (nextTdks.tdk != prevTdk) {
						// 	call.tdks.add(nextTdks.tdk)
						// }
						for (const it of next) {
							if (it.label == call.obj) {
								if (prevDelimiter == Delimiter.Is)
									call.tdks.add(BaseType.tBool)
								else
									call.tdks.add(it.data)
							}
						}
					}
				}
				prevTdks = call.tdks
				if (call.tdks.size > 0)
					continue
			}
			if (call.delimiter == Delimiter.Space) {
				// maybe enum
				let found = false
				for (const en of fileData.completion.enums) {
					if (en.name === call.obj) {
						call.tdks.add(en.tdk)
						found = true
					}
				}
				// or alias
				for (const td of fileData.completion.typeDefs) {
					if (td.name == call.obj) {
						call.tdks.add(td.tdk)
						found = true
					}
				}
				prevTdks = call.tdks
				if (found)
					continue
			}
			else if (call.brackets == Brackets.Round) {
				for (const fn of fileData.completion.functions) {
					if (fn.name == call.obj) {
						call.tdks.add(fn.tdk)
					}
				}
			}
			else if (call.delimiter == Delimiter.ColonColon) {
				// just skip module names
				continue
			}
		}
		// failed to resolve tdk
		break
	}
}

function findNearestTokensAt(doc: TextDocument, fileData: FixedValidationResult, call: CallChain, recursion: number): DasToken[] {
	if (call.obj.length === 0 || fileData.tokens.length === 0)
		return []
	let nearestPos = Position.create(0, 0)
	let nearestToken: DasToken = null
	let nearestAssume: DasToken = null
	let nearestAssumePos = Position.create(0, 0)
	for (const t of fileData.tokens) {
		// ignore fields, we need only top level tokens
		if (t.kind == TokenKind.ExprField)
			continue
		if (t.kind == TokenKind.ExprAssume) {
			if (t.name === call.obj && t._uri == fileData.uri && isPositionLess(t._range.start, call.objRange.start)
				&& isPositionLessOrEqual(nearestAssumePos, t._range.start)
			) {
				nearestAssumePos = t._range.start
				nearestAssume = t
			}
			continue
		}
		if (t.name === call.obj && t._uri == fileData.uri && isPositionLess(t._range.start, call.objRange.start)
			&& isPositionLessOrEqual(nearestPos, t._range.start) && t.tdk.length > 0
		) {
			nearestPos = t._range.start
			nearestToken = t
			continue
		}
	}
	if (nearestAssume != null && (nearestToken == null || isPositionLess(nearestPos, nearestAssumePos))) {
		// resolve assure expression
		// TODO: Assume.declAt is completely wrong in dascript
		const subChain = findCallChain_(doc, fileData, nearestAssume.declAt._range.end, /*forAutocompletion*/false, recursion + 1)
		// search for nearest token in subChain
		if (subChain.length > 0) {
			const last = subChain[subChain.length - 1]
			if (last.tokens.length > 0)
				return last.tokens
		}
	}
	if (nearestToken != null) {
		var res: DasToken[] = [nearestToken]
		for (const t of fileData.tokens) {
			// ignore fields, we need only top level tokens
			if (t.kind == TokenKind.ExprField || t == nearestToken)
				continue
			if (isRangeEqual(t._range, nearestToken._range)) {
				res.push(t)
			}
		}
		return res
	}
	// maybe we have exact match somewhere
	const exactName = fileData.tokens.find(t => t.name === call.obj && t._uri == fileData.uri && t.tdk.length > 0)
	return exactName != null ? [exactName] : []
}

function findTokensUnderCursor(doc: TextDocument, fileData: FixedValidationResult, position: Position): DasToken[] {
	let res: DasToken[] = []
	for (const tok of fileData.tokens) {
		if (tok._uri == fileData.uri
			&& tok._range.start.line == tok._range.end.line
			&& posInRange(position, tok._range)
			&& tok._originalText == doc.getText(tok._range)
			&& tok.tdk.length > 0
		) {
			res.push(tok)
		}
	}
	res.sort((a, b) => isRangeLess(a._range, b._range) ? -1 : 1)
	return res
}

function repeat(ch: string, num: number) {
	let res = ''
	for (let i = 0; i < num; i++)
		res += ch
	return res
}

function fixCompletionSelf(c: CompletionItem, replaceStart: Position, cursorPos: Position): void {
	if (c.insertText != null) {
		fixCompletion(c, c.insertText, replaceStart, cursorPos)
		c.insertText = undefined
	}
}

function fixCompletion(c: CompletionItem, newText: string, replaceStart: Position, cursorPos: Position): void {
	const insertRange = Range.create(replaceStart, Position.create(replaceStart.line, replaceStart.character + newText.length))
	const delRange = Range.create(insertRange.start, cursorPos)
	if (posInRange(cursorPos, insertRange)) {
		// is enough to replace only part of the text, split text in 2 parts
		const delLen = rangeLength(delRange)
		c.additionalTextEdits = [TextEdit.replace(delRange, newText.substring(0, delLen))]
		c.textEdit = TextEdit.insert(cursorPos, newText.substring(delLen))
	} else {
		// text is too short, fully replace prefix part and just insert text as is
		c.additionalTextEdits = [TextEdit.replace(delRange, repeat(' ', rangeLength(delRange)))]
		c.textEdit = TextEdit.insert(cursorPos, newText)
	}
}

const OPERATORS = ["!", "~", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "&&=", "||=", "^^=", "&&", "||", "^^", "+", "-",
	"*", "/", "%", "<", ">", "==", "!=", "<=", ">=", "&", "|", "^", "++", "--", "+++", "---", "<<", ">>", "<<=",
	">>=", "<<<", ">>>", "<<<=", ">>>=", "[]", "?[]", ".", "?.", "??", ":=", "<-", '^^=']

const OPERATOR_REMAP: Map<string, string> = new Map([
	['.', '.'],
	['?.', '?.'],
	['[]', '['],
	['?[]', '?['],
])

function getGlobalCompletion(base: CompletionItem[] = null): CompletionItem[] {
	if (base?.length > 0)
		return base
	const globs = validatingResults.get(globalCompletionFile.uri)
	return globs ? globs.completionItems : []
}

connection.onCompletion(async (textDocumentPosition) => {
	const doc = documents.get(textDocumentPosition.textDocument.uri)
	if (!doc)
		return getGlobalCompletion()
	const fileData = await getDocumentData(textDocumentPosition.textDocument.uri)
	if (!fileData)
		return getGlobalCompletion()
	const callChain = findCallChain(doc, fileData, textDocumentPosition.position, /*forAutocompletion*/true)
	if (callChain.length === 0)
		return getGlobalCompletion(fileData.completionItems)

	const res: CompletionItem[] = []
	const call = callChain.length >= 2 ? callChain[callChain.length - 2] : callChain[callChain.length - 1] // ignore last key (obj.key - we need obj)
	const replaceStart = call.objRange.end
	for (let completionTdk of call.tdks) {
		let actualTdk = completionTdk
		let typeDeclData = fileData.completion.typeDecls.find(td => td.tdk === completionTdk)
		if (typeDeclData != null) {
			let resTd = typeDeclCompletion(typeDeclData, fileData.completion, call.delimiter, call.brackets, res)
			if (resTd.tdk.length > 0)
				actualTdk = resTd.tdk
		}

		for (let it of res) {
			fixCompletionSelf(it, replaceStart, textDocumentPosition.position)
		}

		if (actualTdk.length > 0 && (call.delimiter == Delimiter.Dot || call.delimiter == Delimiter.Pipe)) {
			// fill extension functions
			for (const fn of fileData.completion.functions) {
				if (fn.isClassMethod)
					continue
				if (fn.name.startsWith(PROPERTY_PREFIX))
					continue
				// TODO: ignore const cases: Foo const == Foo
				if (fn.args.length > 0 && fn.args[0].tdk === actualTdk) {
					const propertyName = fixPropertyName(fn.name)
					const isProperty = propertyName != null
					const isOperator = !isProperty && OPERATORS.includes(fn.name)
					const c = CompletionItem.create(isProperty ? propertyName : fn.name)
					c.detail = funcDetail(fn)
					c.documentation = funcDocs(fn)
					c.kind = isProperty ? CompletionItemKind.Property : isOperator ? CompletionItemKind.Operator : CompletionItemKind.Function
					const newText = isProperty ? c.label : isOperator ? OPERATOR_REMAP.get(c.label) ?? c.label : ` |> ${fn.name}(`
					fixCompletion(c, newText, replaceStart, textDocumentPosition.position)
					c.sortText = isProperty ? PROPERTY_SORT : isOperator ? OPERATOR_SORT : EXTENSION_FN_SORT
					const prev = res.find(it => it.label === c.label && it.kind === c.kind && it.detail === c.detail && it.documentation === c.documentation)
					if (prev == null)
						res.push(c)
				}
			}
		}
	}
	if (call.delimiter == Delimiter.ColonColon && call.obj.length > 0) {
		for (const en of fileData.completion.enums) {
			if (en.mod == call.obj) {
				const c = CompletionItem.create(en.name)
				c.detail = enumDetail(en)
				c.documentation = enumDocs(en)
				c.kind = CompletionItemKind.Enum
				c.sortText = FIELD_SORT
				res.push(c)
			}
		}
		for (const st of fileData.completion.structs) {
			if (st.mod === call.obj) {
				const c = CompletionItem.create(st.name)
				c.detail = structDetail(st)
				c.documentation = structDocs(st)
				c.kind = CompletionItemKind.Struct
				c.sortText = FIELD_SORT
				res.push(c)
			}
		}
		for (const fn of fileData.completion.functions) {
			if (fn.mod == call.obj) {
				const c = CompletionItem.create(fn.name)
				c.detail = funcDetail(fn)
				c.documentation = funcDocs(fn)
				c.kind = CompletionItemKind.Function
				c.sortText = FIELD_SORT
				res.push(c)
			}
		}
		for (const td of fileData.completion.typeDefs) {
			if (td.mod == call.obj) {
				const c = CompletionItem.create(td.name)
				c.detail = typedefDetail(td)
				c.documentation = typedefDocs(td)
				c.kind = CompletionItemKind.Interface
				c.sortText = FIELD_SORT
				res.push(c)
			}
		}
	}
	return res.length > 0 ? res : getGlobalCompletion(fileData.completionItems)
})

connection.onHover(async (textDocumentPosition) => {
	const fileData = await getDocumentData(textDocumentPosition.textDocument.uri)
	if (!fileData)
		return null
	const doc = documents.get(fileData.uri)
	if (!doc)
		return null
	const callChain = findCallChain(doc, fileData, textDocumentPosition.position, /*forAutocompletion*/false)
	if (callChain.length === 0)
		return null
	// console.log(JSON.stringify(callChain))
	const last = callChain[callChain.length - 1]
	const settings = await getDocumentSettings(textDocumentPosition.textDocument.uri)
	let res = ''
	let first = true
	for (const tok of last.tokens) {

		if (!first)
			res += '\n'
		first = false
		res += describeToken(tok)
		if (settings.hovers.verbose) {
			//
		}
		if (settings.experimental) {
			res += `\n// ${tok.kind}`
		}

		if (tok.kind == TokenKind.Field) {
			res += `\n//^ ${tok.parentTdk}`
		}

		if (tok.kind == TokenKind.ExprCall /* || tok.kind == 'func' */) {
			const func = fileData.completion.functions.find(f => f.name === tok.name && f.mod === tok.mod)
			if (func != null && func.cpp.length > 0)
				res += `\n[::${func.cpp}(...)]`
		}
		else if (tok.tdk.length > 0) {
			const showBaseType = tok.kind != TokenKind.ExprAddr
			for (const td of fileData.completion.typeDecls) {
				if (td.tdk === tok.tdk) {
					if (showBaseType && !primitiveBaseType(td, fileData.completion))
						res += `\n${typeDeclDocs(td, fileData.completion)}`
					const pos = typeDeclDefinition(td, fileData.completion)
					if (pos._uri?.length > 0)
						res += `\n//@@${pos._uri}`
					if (!isRangeZeroEmpty(pos._range))
						res += `\n//@@${JSON.stringify(pos._range)}`
					break
				}
			}
		}
		if (settings.hovers.verbose) {
			if (tok.declAt._uri?.length > 0)
				res += `\n//@${tok.declAt._uri}`
			if (!isRangeZeroEmpty(tok.declAt._range))
				res += `\n//@${JSON.stringify(tok.declAt._range)}`
		}
		if (settings.experimental) {
			if (tok._uri?.length > 0)
				res += `\n//${tok._uri}`
			res += `\n//${JSON.stringify(tok._range)}`
		}

	}
	if (res.length == 0) {
		for (const tdk of last.tdks) {
			for (const td of fileData.completion.typeDecls) {
				if (td.tdk === tdk) {
					if (!first)
						res += '\n'
					first = false
					res += `${last.obj} : ${typeDeclDetail(td)}`
					if (!primitiveBaseType(td, fileData.completion)) {
						const doc = typeDeclDocs(td, fileData.completion)
						res += `\n${doc}`
					}
					break
				}
			}
		}
	}
	// fallback logic, lets try to find any completion item with same name
	if (res.length == 0 && last.obj.length > 0) {
		for (const en of fileData.completionItems) {
			if (en.label === last.obj && en.detail) {
				if (!first)
					res += '\n'
				res += `\n${en.detail}`
				break
			}
		}
	}
	if (res.length > 0)
		return {
			contents: { kind: 'markdown', value: '```dascript\n' + res + '\n```' },
			range: last.tokens.length > 0 ? last.tokens[0]._range : Range.create(textDocumentPosition.position, textDocumentPosition.position),
		}
	return null
})

connection.onTypeDefinition(async (typeDefinitionParams) => {
	const doc = documents.get(typeDefinitionParams.textDocument.uri)
	if (!doc)
		return null
	const fileData = await getDocumentData(typeDefinitionParams.textDocument.uri)
	if (!fileData)
		return null
	const callChain = findCallChain(doc, fileData, typeDefinitionParams.position, /*forAutocompletion*/false)
	if (callChain.length === 0)
		return null
	const last = callChain[callChain.length - 1]
	let res: Location[] = []

	const resTdks = last.tokens.length > 0 ? last.tokens.map(it => it.tdk) : last.tdks
	for (const resTdk of resTdks) {
		for (const td of fileData.completion.typeDecls) {
			if (td.tdk === resTdk) {
				const pos = typeDeclDefinition(td, fileData.completion)
				addValidLocation(res, pos)
				break
			}
		}
	}

	const resAliases: Array<{ mod: string, name: string }> = last.tokens.length > 0 ? last.tokens.map(it => ({ mod: it.mod, name: it.alias })) : []
	for (const resAlias of resAliases) {
		if (resAlias.name.length === 0)
			continue
		const tf = fileData.completion.typeDefs.find(td => td.name === resAlias.name && td.mod === resAlias.mod)
		if (tf != null) {
			addValidLocation(res, tf)
		}
	}

	for (const tok of last.tokens) {
		if (tok.kind == TokenKind.Struct || tok.kind == TokenKind.Handle) {
			// it's fast :)
			const st = fileData.completion.structs.find(st => st.name === tok.name && st.mod === tok.mod)
			if (st != null) {
				const st2 = getParentStruct(st, fileData.completion)
				addValidLocation(res, st2)
			}
		}
	}
	return res.length > 0 ? res : null
})

connection.onReferences(async (referencesParams) => {
	const doc = documents.get(referencesParams.textDocument.uri)
	if (!doc)
		return null
	const fileData = await getDocumentData(referencesParams.textDocument.uri)
	if (!fileData)
		return null
	const callChain = findCallChain(doc, fileData, referencesParams.position, /*forAutocompletion*/false)
	if (callChain.length === 0)
		return null
	const last = callChain[callChain.length - 1]
	const foundTokens = last.tokens

	let result: Location[] = []

	for (const res of foundTokens) {
		let declAt = res.kind === TokenKind.Func ? res : res.declAt
		if (declAt.file.length === 0) {
			continue
		}
		result.push(Location.create(declAt._uri, declAt._range))

		if (!isRangeZeroEmpty(declAt._range)) {
			for (const td of fileData.tokens) {
				if (isRangeEqual(declAt._range, td.declAt._range)) {
					result.push(Location.create(td._uri, td._range))
				}
			}
		}
	}

	return result
})

connection.onDefinition(async (declarationParams) => {
	const doc = documents.get(declarationParams.textDocument.uri)
	if (!doc)
		return null
	const fileData = await getDocumentData(declarationParams.textDocument.uri)
	if (!fileData)
		return null
	const callChain = findCallChain(doc, fileData, declarationParams.position, /*forAutocompletion*/false)
	if (callChain.length === 0)
		return null
	let res: Location[] = []
	const last = callChain[callChain.length - 1]
	for (const tok of last.tokens) {
		addValidLocation(res, tok.declAt)

		if (tok.kind == TokenKind.ExprAddr) {
			// function call
			const func = fileData.completion.functions.find(f => f.name === tok.name && f.mod === tok.mod)
			if (func)
				addValidLocation(res, func.decl)
		}
		if (tok.kind == TokenKind.Typedecl) {
			const td = fileData.completion.typeDecls.find(td => td.tdk === tok.tdk)
			if (td != null) {
				const pos = typeDeclDefinition(td, fileData.completion)
				addValidLocation(res, pos)
			}
			if (tok.alias.length > 0) {
				const td = fileData.completion.typeDefs.find(td => td.name === tok.alias && td.mod === tok.mod)
				if (td != null) {
					addValidLocation(res, td)
				}
			}
		}

		if (tok.kind == TokenKind.ExprGoto) {
			// TODO: search label with same name
			// name === goto label 0 -> label 0
		}

		if (tok.kind == TokenKind.Struct || tok.kind == TokenKind.Handle) {
			for (const st of fileData.completion.structs) {
				if (st.parentName === tok.name && st.parentMod === tok.mod) {
					addValidLocation(res, st)
				}
			}
		}

		const parentTdks: Set<string> = tok.parentTdk.length > 0 ? new Set(tok.parentTdk) : callChain.length > 1 ? callChain[callChain.length - 2].tdks : new Set()
		for (const parentTdk of parentTdks) {
			for (const td of fileData.completion.typeDecls) {
				if (td.tdk === parentTdk) {
					// TODO: find pos for field tdk.name
					const pos = typeDeclDefinition(td, fileData.completion)
					addValidLocation(res, pos)
					break
				}
			}
		}
	}
	if (last.tokens.length === 0) {
		const prev = callChain.length > 1 ? callChain[callChain.length - 2] : null
		if (prev) {
			for (const tdk of prev.tdks) {
				const typeDecl = fileData.completion.typeDecls.find(td => td.tdk === tdk)
				if (typeDecl) {
					// TODO: find pos for field tdk.name
					const pos = typeDeclDefinition(typeDecl, fileData.completion)
					addValidLocation(res, pos)
				}
			}
		}
	}

	return res.length > 0 ? res : null
})

connection.onDocumentSymbol(async (documentSymbolParams) => {
	const fileData = await getDocumentData(documentSymbolParams.textDocument.uri)
	if (!fileData)
		return null
	const res: DocumentSymbol[] = []
	for (const glob of fileData.completion.globals) {
		if (glob._uri != documentSymbolParams.textDocument.uri)
			continue
		res.push({
			name: glob.name,
			kind: SymbolKind.Variable,
			detail: globalDetail(glob),
			range: glob._range,
			selectionRange: glob._range,
		})
	}
	for (const st of fileData.completion.structs) {
		if (st.gen)
			continue
		if (st._uri != documentSymbolParams.textDocument.uri)
			continue
		const stRes: DocumentSymbol = {
			name: st.name,
			kind: st.isClass ? SymbolKind.Class : SymbolKind.Struct,
			detail: structDetail(st),
			range: st._range,
			selectionRange: st._range,
			children: [],
		}
		for (const f of st.fields) {
			if (f.gen)
				continue
			if (f._uri != documentSymbolParams.textDocument.uri)
				continue
			stRes.children.push({
				name: f.name,
				kind: SymbolKind.Field,
				range: f._range,
				selectionRange: f._range,
			})
		}
		res.push(stRes)
	}
	for (const en of fileData.completion.enums) {
		if (en._uri != documentSymbolParams.textDocument.uri)
			continue
		const enRes: DocumentSymbol = {
			name: en.name,
			kind: SymbolKind.Enum,
			detail: enumDetail(en),
			range: en._range,
			selectionRange: en._range,
			children: [],
		}
		for (const ev of en.values) {
			if (ev._uri != documentSymbolParams.textDocument.uri)
				continue
			enRes.children.push({
				name: ev.name,
				kind: SymbolKind.EnumMember,
				detail: enumValueDetail(ev),
				range: ev._range,
				selectionRange: ev._range,
			})
		}
		res.push(enRes)
	}
	for (const td of fileData.completion.typeDefs) {
		if (td._uri != documentSymbolParams.textDocument.uri)
			continue
		let tdRes: DocumentSymbol = {
			name: td.name,
			kind: SymbolKind.Interface,
			detail: typedefDetail(td),
			range: td._range,
			selectionRange: td._range,
			children: [],
		}
		res.push(tdRes)
		const ctd = fileData.completion.typeDecls.find(it => it.tdk === td.tdk)
		if (ctd != null) {
			for (const f of ctd.fields) {
				tdRes.children.push({
					name: f.name,
					kind: SymbolKind.Field,
					detail: typeDeclFieldDetail(f),
					range: td._range,
					selectionRange: td._range,
				})
			}
		}
	}
	for (const fn of fileData.completion.functions) {
		if (fn.gen || fn.isClassMethod)
			continue
		if (fn._uri != documentSymbolParams.textDocument.uri)
			continue
		res.push({
			name: fn.name,
			kind: SymbolKind.Function,
			detail: funcDetail(fn),
			range: fn._range,
			selectionRange: fn._range,
		})
	}
	return res
})

connection.languages.inlayHint.on(async (inlayHintParams) => {
	const doc = documents.get(inlayHintParams.textDocument.uri)
	if (!doc)
		return null
	const fileData = await getDocumentData(inlayHintParams.textDocument.uri)
	if (!fileData)
		return null
	const res: InlayHint[] = []
	let idx = 0
	const n = fileData.tokens.length
	while (idx < n - 1) {
		const token = fileData.tokens[idx]
		let nextToken = fileData.tokens[idx + 1]
		++idx
		if (isPositionLessOrEqual(inlayHintParams.range.start, token._range.start)
			&& isPositionLess(token._range.end, inlayHintParams.range.end)
			&& token._uri == inlayHintParams.textDocument.uri) {
			// console.log(token)
			if (token.kind == TokenKind.ExprLet || token.kind == TokenKind.ExprFor || token.kind == TokenKind.FuncArg || token.kind == TokenKind.BlockArg) {
				// ignore let generated in dascript generateComprehension(...)
				if (token.name.startsWith('__acomp'))
					continue
				// sometimes typedecl cover whole let expression, ignore it case
				if (nextToken.kind != TokenKind.Typedecl || isRangeLengthZero(nextToken._range) || isPositionLessOrEqual(nextToken._range.start, token._range.start)) {
					const short = shortTdk(token.tdk)
					res.push({
						label: `: ${short}`,
						position: token._range.end,
						kind: InlayHintKind.Type,
					})
				}
				continue
			}
			if (token.kind == TokenKind.Func) {
				if (nextToken.kind == TokenKind.FuncArg) {
					var skip = 0
					while (nextToken.kind == TokenKind.FuncArg) {
						skip += 2
						nextToken = fileData.tokens[idx + skip]
					}
				}
				if (nextToken.kind != TokenKind.Typedecl || isRangeLengthZero(nextToken._range)) {
					const short = shortTdk(token.tdk)
					res.push({
						label: `: ${short}`,
						position: closedBracketPos(doc, token._range.end),
						kind: InlayHintKind.Type,
					})
				}
			}

		}
	}
	return res
})

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined)
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			// TODO: support multiple workspace folders
			connection.console.log('Workspace folder change event received.')
		})
	}
})

let globalSettings = defaultSettings

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear()
	} else {
		globalSettings = <DasSettings>((change.settings || defaultSettings))
	}

	// Revalidate all open text documents
	// TODO: queue validation
	documents.all().forEach(updateDocumentData)
})

function getDocumentSettings(resource: string): Thenable<DasSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings)
	}
	let result = documentSettings.get(resource)
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'dascript'
		})
		documentSettings.set(resource, result)
	}
	return result
}

function stringHashCode(str: string) {
	let hash = 0
	if (str.length === 0) return hash
	for (let i = 0; i < str.length; i++) {
		const chr = str.charCodeAt(i)
		hash = ((hash << 5) - hash) + chr
		hash |= 0 // Convert to 32bit integer
	}
	return hash
}

let validateId = 0

interface ValidatingProcess {
	version: integer
	process: ChildProcessWithoutNullStreams
	promise: Promise<void>
}

const globalCompletionFile = TextDocument.create('$$$completion$$$.das', 'dascript', 1, '// empty')
const validatingProcesses = new Map<string, ValidatingProcess>()

async function getDocumentDataRaw(uri: string, doc: TextDocument): Promise<FixedValidationResult> {
	const data = validatingResults.get(uri)
	if (data)
		return data
	const loadingData = validatingProcesses.get(uri)
	if (loadingData) {
		return loadingData.promise.then(() => {
			return validatingResults.get(uri)
		})
	}
	return validateTextDocument(doc).then(() => {
		return validatingResults.get(uri)
	})
}

function updateDocumentData(doc: TextDocument) {
	getDocumentDataRaw(globalCompletionFile.uri, globalCompletionFile).then(() => {
		validateTextDocument(doc)
	})
}

async function getDocumentData(uri: string): Promise<FixedValidationResult> {
	return getDocumentDataRaw(globalCompletionFile.uri, globalCompletionFile).then(() => {
		let doc = documents.get(uri)
		if (!doc) {
			console.log('document not found', uri)
			return null
		}
		return getDocumentDataRaw(uri, doc).then(() => {
			return validatingResults.get(uri)
		})
	})
}

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
	const prevProcess = validatingProcesses.get(textDocument.uri)
	console.log('prevProcess version', prevProcess?.version ?? -1)
	if (prevProcess != null) {
		if (prevProcess.version === textDocument.version) {
			console.log('document version not changed, ignoring', textDocument.uri)
			return prevProcess.promise
		}
		prevProcess.process?.kill()
		validatingProcesses.delete(textDocument.uri)
		console.log('killed process for', textDocument.uri)
	}
	const validResult = validatingResults.get(textDocument.uri)
	// console.log('validResult', validResult)
	if (validResult?.fileVersion === textDocument.version) {
		console.log('document version not changed, ignoring', textDocument.uri)
		return Promise.resolve()
	}
	const settings = await getDocumentSettings(textDocument.uri)

	const filePath = URI.parse(textDocument.uri).fsPath
	const tempFilePrefix = `${stringHashCode(textDocument.uri).toString(16)}_${validateId.toString(16)}_${textDocument.version.toString(16)}`
	const tempFileName = `${tempFilePrefix}_${path.basename(filePath)}`
	const resultFileName = `${tempFileName}_res`
	validateId++
	const tempFilePath = path.join(os.tmpdir(), tempFileName)
	const resultFilePath = path.join(os.tmpdir(), resultFileName)
	await fs.promises.writeFile(tempFilePath, textDocument.getText())
	await fs.promises.writeFile(resultFilePath, '')

	const args = settings.server.args.map(arg => arg.replace('${file}', 'validate_file.das'))
	if (args.indexOf('--') < 0)
		args.push('--')
	args.push('--file', tempFilePath)
	args.push('--original-file', filePath)
	args.push('--result', resultFilePath)
	args.push('--args', `"${settings.server.args.join(' ')}"`)
	if (settings.project.file)
		args.push('--project-file', settings.project.file)
	if (settings.policies?.ignore_shared_modules)
		args.push('--ignore-shared-modules')
	if (settings.policies?.no_global_variables)
		args.push('--no-global-variables')
	if (settings.policies?.no_unused_block_arguments)
		args.push('--no-unused-block-arguments')
	if (settings.policies?.no_unused_function_arguments)
		args.push('--no-unused-function-arguments')
	if (settings.policies?.fail_on_lack_of_aot_export)
		args.push('--fail-on-lack-of-aot-export')
	if (textDocument == globalCompletionFile)
		args.push('--global-completion')
	const workspaceFolder = URI.parse(workspaceFolders![0].uri).fsPath
	for (const rootName in settings.project.fileAccessRoots) {
		const fixedRoot = settings.project.fileAccessRoots[rootName].replace('${workspaceFolder}', workspaceFolder)
		args.push('--file-access-root', `${rootName}:${fixedRoot}`)
	}

	const scriptPath = process.argv[1]
	const cwd = path.dirname(path.dirname(scriptPath))
	console.log(`> validating ${textDocument.uri} version ${textDocument.version}`)
	console.log('> cwd', cwd)
	console.log('> exec', settings.compiler, args.join(' '))
	const vp: ValidatingProcess = { process: null, version: textDocument.version, promise: null }
	validatingProcesses.set(textDocument.uri, vp)
	const child = spawn(settings.compiler, args, { cwd: cwd })
	vp.process = child

	vp.promise = new Promise<void>((resolve, reject) => {

		const diagnostics: Map<string, Diagnostic[]> = new Map()
		diagnostics.set(textDocument.uri, [])
		let output = ''
		child.stdout.on('data', (data: any) => {
			output += data
		})
		child.stderr.on('data', (data: any) => {
			diagnostics.get(textDocument.uri).push({ range: Range.create(0, 0, 0, 0), message: `${data}` })
		})
		child.on('error', (error: any) => {
			diagnostics.get(textDocument.uri).push({ range: Range.create(0, 0, 0, 0), message: `${error}` })
			reject(error)
		})
		child.on('close', (exitCode: any) => {
			const validateTextResult = fs.readFileSync(resultFilePath, 'utf8')
			// console.log('remove temp files', tempFilePath, resultFilePath)
			fs.rmSync(tempFilePath)
			fs.rmSync(resultFilePath)

			if (exitCode === null) {
				console.log('Validation process exited with code', exitCode)
				return
			}

			if (textDocument.uri != globalCompletionFile.uri && documents.get(textDocument.uri)?.version !== textDocument.version) {
				console.log('document version changed, ignoring result', textDocument.uri)
				return
			}

			// console.log(validateTextResult)
			let result: ValidationResult = null
			try {
				if (validateTextResult.length > 0)
					result = JSON.parse(validateTextResult) as ValidationResult
			}
			catch (e) {
				console.log('failed to parse result', e)
				console.log('"""', validateTextResult, '"""')
			}
			// console.log(result) // TODO: remove this log
			if (result != null) {
				for (const error of result.errors) {
					error._range = AtToRange(error)
					error._uri = AtToUri(error, textDocument.uri, settings, result.dasRoot)

					const diag: Diagnostic = { range: error._range, message: error.what, code: error.cerr, severity: error.level === 0 ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning }
					if (error.extra?.length > 0 || error.fixme?.length > 0) {
						const info: DiagnosticRelatedInformation[] = []
						let lines: string[] = []
						if (error.extra?.length > 0)
							lines = error.extra.split('\n')
						if (error.fixme?.length > 0)
							lines = lines.concat(error.fixme.split('\n'))
						for (const line of lines) {
							if (line.trim().length !== 0)
								info.push({ location: { uri: error._uri, range: error._range }, message: line })
						}
						diag.relatedInformation = info
					}
					if (!diagnostics.has(error._uri))
						diagnostics.set(error._uri, [])
					diagnostics.get(error._uri).push(diag)
				}
				console.time('storeValidationResult')
				storeValidationResult(settings, textDocument, result)
				console.timeEnd('storeValidationResult')
			} else { // result == null
				if (!diagnostics.has(textDocument.uri))
					diagnostics.set(textDocument.uri, [])
				diagnostics.get(textDocument.uri).push({ range: Range.create(0, 0, 0, 0), message: `internal error: Validation process exited with code ${exitCode}.` })
			}
			if (exitCode !== 0 || result == null) {
				console.log('internal error: Validation process exited with code', exitCode, 'but no errors were reported. Please report this issue.')
				console.log('"""', output, '"""')
			}
			for (const [uri, diags] of diagnostics.entries()) {
				connection.sendDiagnostics({ uri: uri, diagnostics: diags })
			}
			validatingProcesses.delete(textDocument.uri)
			resolve()
		})
	})
	return vp.promise
}

function addCompletionItem(map: Array<Map<string, CompletionItem>>, item: CompletionItem) {
	while (map.length <= item.kind)
		map.push(new Map())
	const items = map[item.kind]
	const it = items.get(item.label)
	if (it != null && it.detail == item.detail) {
		it.documentation += '\n' + item.documentation
		return
	}
	items.set(item.label, item)
}

function baseTypeToCompletionItemKind(baseType: string) {
	if (baseType === 'block' || baseType === 'lambda' || baseType === 'function')
		return CompletionItemKind.Function

	return CompletionItemKind.Struct
}

function storeValidationResult(settings: DasSettings, doc: TextDocument, res: ValidationResult) {
	const uri = doc.uri
	const fileVersion = doc.version
	console.log('storeValidationResult', uri, 'version', fileVersion)
	const fixedResults: FixedValidationResult = { ...res, uri: uri, completionItems: [], fileVersion: fileVersion, filesCache: new Map() }
	if (res.errors.length > 0) {
		// keep previous completion items
		const prev = validatingResults.get(uri)
		if (prev) {
			fixedResults.completion = prev.completion
			fixedResults.completionItems = prev.completionItems
			fixedResults.tokens = prev.tokens
		}
	}
	else {
		if (uri != globalCompletionFile.uri) {
			const globs = validatingResults.get(globalCompletionFile.uri)
			if (globs) {
				console.log('>>> merge global completion')
				fixedResults.completion.structs.unshift(...globs.completion.structs)
				fixedResults.completion.enums.unshift(...globs.completion.enums)
				fixedResults.completion.typeDecls.unshift(...globs.completion.typeDecls)
				fixedResults.completion.typeDefs.unshift(...globs.completion.typeDefs)
				fixedResults.completion.globals.unshift(...globs.completion.globals)
				fixedResults.completion.functions.unshift(...globs.completion.functions)
			}
		}
		const modules = new Set<string>()
		const map = new Array<Map<string, CompletionItem>>()
		function addMod(name: string, at: CompletionAt) {
			if (name?.length > 0 && !modules.has(name)) {
				modules.add(name)
				addCompletionItem(map, {
					label: name,
					kind: CompletionItemKind.Module,
					detail: `module ${name}`,
					documentation: `module ${name}\n${at.file}`,
				})
			}
		}
		for (const e of res.completion.enums) {
			e._range = AtToRange(e)
			e._uri = AtToUri(e, uri, settings, res.dasRoot, fixedResults.filesCache)
			addCompletionItem(map, {
				label: e.name,
				kind: CompletionItemKind.Enum,
				detail: enumDetail(e),
				documentation: enumDocs(e),
			})
			addMod(e.mod, e)
			for (const ev of e.values) {
				ev._range = AtToRange(ev)
				ev._uri = AtToUri(ev, uri, settings, res.dasRoot, fixedResults.filesCache)
				addCompletionItem(map, {
					label: ev.name,
					kind: CompletionItemKind.EnumMember,
					detail: enumValueDetail(ev),
					documentation: enumValueDocs(ev, e),
				})
			}
		}
		for (const s of res.completion.structs) {
			s.column = Math.max(s.column - 5, 0) // magic number to fix column
			s._range = AtToRange(s)
			s._uri = AtToUri(s, uri, settings, res.dasRoot, fixedResults.filesCache)
			addCompletionItem(map, {
				label: s.name,
				kind: s.isClass ? CompletionItemKind.Class : CompletionItemKind.Struct,
				detail: structDetail(s),
				documentation: structDocs(s),
			})
			addMod(s.mod, s)
			for (const sf of s.fields) {
				// TODO: search for the field end using textDocument.getText()
				// sf.columnEnd += sf.tdk.length + 1 // 1 char for ':'
				sf._range = AtToRange(sf)
				sf._uri = AtToUri(sf, uri, settings, res.dasRoot, fixedResults.filesCache)
				addCompletionItem(map, {
					label: sf.name,
					kind: CompletionItemKind.Field,
					detail: structFieldDetail(sf),
					documentation: structFieldDocs(sf, s),
				})
			}
		}
		for (const t of res.completion.typeDecls) {
			t._range = AtToRange(t)
			t._uri = AtToUri(t, uri, settings, res.dasRoot, fixedResults.filesCache)
			addCompletionItem(map, {
				label: t.tdk,
				kind: baseTypeToCompletionItemKind(t.baseType),
				detail: typeDeclDetail(t),
				documentation: typeDeclDocs(t, res.completion),
			})
			for (const tf of t.fields) {
				addCompletionItem(map, {
					label: tf.name,
					kind: CompletionItemKind.Field,
					detail: typeDeclFieldDetail(tf),
					documentation: typeDeclFieldDocs(tf, t),
				})
			}
		}
		for (const t of res.completion.typeDefs) {
			t._range = AtToRange(t)
			t._uri = AtToUri(t, uri, settings, res.dasRoot, fixedResults.filesCache)
			const valueType = res.completion.typeDecls.find(td => td.tdk === t.tdk)
			addCompletionItem(map, {
				label: t.name,
				kind: valueType != null ? baseTypeToCompletionItemKind(valueType.baseType) : CompletionItemKind.Struct,
				detail: typedefDetail(t),
				documentation: typedefDocs(t),
			})
			addMod(t.mod, t)
		}
		for (const g of res.completion.globals) {
			g._range = AtToRange(g)
			g._uri = AtToUri(g, uri, settings, res.dasRoot, fixedResults.filesCache)
			addCompletionItem(map, {
				label: g.name,
				kind: CompletionItemKind.Variable,
				detail: globalDetail(g),
				documentation: globalDocs(g),
			})
			addMod(g.mod, g)
		}
		for (const f of res.completion.functions) {
			f._range = AtToRange(f)
			f._uri = AtToUri(f, uri, settings, res.dasRoot, fixedResults.filesCache)
			f.decl._range = AtToRange(f.decl)
			f.decl._uri = AtToUri(f.decl, uri, settings, res.dasRoot, fixedResults.filesCache)
			if ((f.args.length == 1 || f.args.length == 2) && f.name.startsWith(PROPERTY_PREFIX)) {
				let found = false
				const td = res.completion.typeDecls.find(td => td.tdk === f.args[0].tdk)
				if (td) {
					typeDeclIter(td, res.completion, (td, st, en) => {
						if (st) {
							found = true
							let name = f.name.substring(2)
							let writeProp = false
							if (name.endsWith('`clone')) {
								name = name.substring(0, name.length - 6)
								writeProp = true
							}
							let prop = st.fields.find(f => f.name === name && f._property)
							if (prop) {
								if (writeProp)
									prop._writeFn = f
								else
									prop._readFn = f
							} else {
								st.fields.push({
									name: name,
									tdk: f.tdk,
									offset: -1,
									isPrivate: false,
									_range: f._range,
									_uri: f._uri,
									gen: f.gen,
									file: f.file,
									line: f.line,
									lineEnd: f.lineEnd,
									column: f.column,
									columnEnd: f.columnEnd,
									_originalText: f._originalText,
									_property: true,
									_readFn: !writeProp ? f : null,
									_writeFn: writeProp ? f : null,
								})
							}
						}
					})
				}
				if (found)
					continue
			}
			addCompletionItem(map, {
				label: f.name,
				kind: CompletionItemKind.Function,
				detail: funcDetail(f),
				documentation: funcDocs(f),
			})
			addMod(f.mod, f)
			for (const arg of f.args) {
				arg._range = AtToRange(arg)
				arg._uri = AtToUri(arg, uri, settings, res.dasRoot, fixedResults.filesCache)
				addCompletionItem(map, {
					label: arg.name,
					kind: CompletionItemKind.Variable,
					detail: funcArgDetail(arg),
					documentation: funcArgDocs(arg),
				})
			}
		}

		const tokens = fixedResults.tokens
		fixedResults.tokens = []

		for (const token of tokens) {
			token._uri = AtToUri(token, uri, settings, res.dasRoot, fixedResults.filesCache)
			if (token._uri != uri) // filter out tokens from other files
				continue
			if (token.kind == TokenKind.ExprField)
				token.columnEnd += token.name.length
			token._range = AtToRange(token)
			token._originalText = doc.getText(token._range)
			// declAt is negative for tokens that are not declared in the source code
			if (token.declAt.line >= 0) {
				token.declAt._range = AtToRange(token.declAt)
				token.declAt._uri = AtToUri(token.declAt, uri, settings, res.dasRoot, fixedResults.filesCache)
			}
			else {
				token.declAt._range = Range.create(0, 0, 0, 0)
				token.declAt._uri = ''
			}
			fixedResults.tokens.push(token)
			// TODO: add completion items for tokens
			if (token.kind == TokenKind.ExprVar) {
				addCompletionItem(map, {
					label: token.name,
					kind: CompletionItemKind.Variable,
					detail: token.name,
					documentation: describeToken(token),
				})
			}
		}

		for (const [_, items] of map.entries()) {
			fixedResults.completionItems.push(...items.values())
		}
		for (const item of fixedResults.completionItems) {
			// settings.experimental
			if (item.detail.length > 0) {
				item.documentation = {
					kind: 'markdown',
					value: '```dascript\n' + item.documentation + '\n```'
				}
			}
		}
	}

	validatingResults.set(uri, fixedResults)
}

connection.listen()
