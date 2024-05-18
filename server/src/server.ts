
import {
	createConnection, TextDocuments, ProposedFeatures, TextDocumentSyncKind, WorkspaceFolder, DidChangeConfigurationNotification, integer, Range, Diagnostic, DiagnosticRelatedInformation, CompletionItem, CompletionItemKind, Hover, MarkupContent, Location, DiagnosticSeverity, SymbolKind, SymbolInformation,
	Position,
	DocumentSymbol
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
import { AtToRange, AtToUri, Brackets, DasToken, Delimiter, FixedValidationResult, ValidationResult, describeToken, enumDetail, enumDocs, enumValueDetail, enumValueDocs, funcArgDetail, funcArgDocs, funcDetail, funcDocs, getParentStruct, globalDetail, globalDocs, isPositionLess, isRangeLess, isRangeZeroEmpty, isValidIdChar, posInRange, primitiveBaseType, rangeCenter, structDetail, structDocs, structFieldDetail, structFieldDocs, typeDeclCompletion, typeDeclDefinition, typeDeclDetail, typeDeclDocs, typeDeclFieldDetail, typeDeclFieldDocs, typeDeclItemTdk, typedefDetail, typedefDocs } from './completion'


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
	validateTextDocument(event.document)
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
				triggerCharacters: ['.'],
			},
			hoverProvider: true,
			definitionProvider: true,
			// declarationProvider: true,
			typeDefinitionProvider: true,
			documentSymbolProvider: true,
			referencesProvider: true,
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
	token?: DasToken
	tdk: string
	delimiter: Delimiter
	brackets: Brackets
}

function findCallChain(fileData: FixedValidationResult, pos: Position, forAutocompletion: boolean): CallChain[] {
	/// find key foo.key  foo().key  ... etc
	/// support sequence of calls: foo.key.key2.key3
	const doc = documents.get(fileData.uri)
	if (doc == null)
		return []
	const line = doc.getText(Range.create(pos.line, 0, pos.line, pos.character))
	let key = ""
	let keyRange: Range
	let i = line.length - 1
	let tok: DasToken = null
	let del = Delimiter.None
	if (!forAutocompletion) {
		// lets try to find token under cursor
		const cursorTok = findTokenUnderCursor(fileData, pos)
		if (cursorTok != null) {
			const currentText = doc.getText(cursorTok._range)
			// check if token name is in the current text
			if (cursorTok.name.indexOf(currentText) >= 0 || currentText.indexOf(cursorTok.name) >= 0) {
				tok = cursorTok
				key = tok.name
				keyRange = tok._range
				i = doc.offsetAt(tok._range.start) - doc.offsetAt(Position.create(pos.line, 0)) - 1
			}
		}
	}

	if (forAutocompletion || tok == null) {
		// auto completion or token not found - find it manually
		for (; i >= 0; i--) {
			const ch = line[i]
			if (ch === ' ' || ch === '\t') {
				del = Delimiter.Space
				if (key.length === 0)
					continue
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

	if (del === Delimiter.Space && (key == "as" || key == "is" || key == "?as")) {
		// skip 'as' 'is' '?as' in case when space is delimiter
		// `foo as |` - converts to ["foo", ""], not to ["foo", "as"]
		key = ""
		keyRange = Range.create(pos.line, i + 1 + key.length, pos.line, i + 1 + key.length)
	}
	else {
		// skip spaces
		for (; i >= 0; i--) {
			const ch = line[i]
			if (ch !== ' ' && ch !== '\t')
				break
		}
	}
	const keyData: CallChain = { obj: key, objRange: keyRange, token: tok, tdk: tok ? tok.tdk : "", delimiter: del, brackets: Brackets.None }

	let res: CallChain[] = [keyData]
	while (i > 0) {
		del = Delimiter.None
		// '.' ' ' '?.' '->' 'as' 'is' '?as' '|>'

		if (line[i] === '.') {
			i -= 1
			del = Delimiter.Dot
		}
		else if (line[i] === ' ') {
			i -= 1
			del = Delimiter.Space
		}
		else if (i > 0 && line[i] === '.' && line[i - 1] === '?') {
			i -= 2
			del = Delimiter.QuestionDot
		}
		else if (i > 0 && line[i] === '>' && line[i - 1] === '-') {
			i -= 2
			del = Delimiter.Arrow
		}
		else if (i > 0 && line[i] === 's' && line[i - 1] === 'a') {
			i -= 2
			del = Delimiter.As
		}
		else if (i > 0 && line[i] === 's' && line[i - 1] === 'i') {
			i -= 2
			del = Delimiter.Is
		}
		else if (i > 1 && line[i] === 's' && line[i - 1] === 'a' && line[i - 2] === '?') {
			i -= 3
			del = Delimiter.QuestionAs
		}
		else if (i > 0 && line[i] === '>' && line[i - 1] === '|') {
			i -= 2
			del = Delimiter.Pipe
		}
		if (del === Delimiter.None)
			break
		// skip spaces
		for (; i >= 0; i--) {
			const ch = line[i]
			if (ch !== ' ' && ch !== '\t')
				break
		}
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

				// skip spaces
				for (; i >= 0; i--) {
					const ch = line[i]
					if (ch !== ' ' && ch !== '\t')
						break
				}
			}
		}

		let obj = ""
		for (; i >= 0; i--) {
			const ch = line[i]
			if (isValidIdChar(ch))
				obj = ch + obj
			else
				break
		}
		if (obj.length === 0) { break }
		const objRange = Range.create(pos.line, i + 1, pos.line, i + 1 + obj.length)
		res.unshift({ obj: obj, objRange: objRange, tdk: "", delimiter: del, brackets: brackets })
	}

	resolveChainTdk(fileData, res, !forAutocompletion)
	return res
}

function resolveChainTdk(fileData: FixedValidationResult, callChain: CallChain[], forAutocompletion: boolean): void {
	if (callChain.length === 0)
		return
	const last = callChain[callChain.length - 1]
	if (!forAutocompletion && last.token != null) {
		return
	}

	let prevTdk: string = ""
	var idx = 0
	while (idx < callChain.length) {
		const call = callChain[idx]
		idx++
		// maybe already exists token
		if (call.token != null) {
			call.tdk = call.token.tdk
			prevTdk = call.tdk
			continue
		}
		if (prevTdk.length > 0 && call.obj.length > 0) {
			// resolve tdk for type decls
			let typeDeclData = fileData.completion.typeDecls.find(td => td.tdk === prevTdk)
			if (typeDeclData != null) {
				const nextTdk = typeDeclItemTdk(typeDeclData, fileData.completion, call.obj)
				if (nextTdk.length > 0) {
					call.tdk = nextTdk
					prevTdk = nextTdk
					continue
				}
			}
		}
		if (idx == 1) {
			const tok = call.token ? call.token : findTokenAt(fileData, call, /*exact match*/true)
			if (tok != null) {
				call.token = tok
				call.tdk = tok.tdk
				prevTdk = tok.tdk
				continue
			}
		}
		if (call.delimiter == Delimiter.Space && call.obj.length > 0) {
			// maybe enum
			// TODO: add bitfields here too
			const enumData = fileData.completion.enums.find(e => e.name === call.obj)
			if (enumData != null) {
				call.tdk = enumData.tdk
				prevTdk = enumData.tdk
				continue
			}
		}
		// failed to resolve tdk
		break
	}
}

function findTokenAt(fileData: FixedValidationResult, call: CallChain, exactMatch = false): DasToken {
	if (call.token != null)
		return call.token
	if (call.obj.length === 0 || fileData.tokens.length === 0)
		return null
	let nearestPos = Position.create(0, 0)
	let resToken: DasToken
	for (let index = 0; index < fileData.tokens.length; index++) {
		const t = fileData.tokens[index]
		// ignore fields, we need only top level tokens
		if (t.kind == 'ExprField')
			continue
		if (t.name === call.obj && t._uri == fileData.uri && isPositionLess(t._range.start, call.objRange.start) && isPositionLess(nearestPos, t._range.start)) {
			nearestPos = t._range.start
			resToken = t
			continue
		}
	}
	if (resToken != null) {
		return resToken
	}
	// maybe we have exact match somewhere
	const exactName = fileData.tokens.find(t => t.name === call.obj && t._uri == fileData.uri)
	if (exactName != null)
		return exactName
	if (exactMatch)
		return null
	// lets try to find any token in given range
	return findTokenUnderCursor(fileData, rangeCenter(call.objRange))
}

function findTokenUnderCursor(fileData: FixedValidationResult, position: Position): DasToken {
	let res: DasToken = null
	for (const tok of fileData.tokens) {
		if (tok._uri == fileData.uri && posInRange(position, tok._range) && (res == null || isRangeLess(tok._range, res._range))) {
			res = tok
		}
	}
	return res
}

connection.onCompletion(async (textDocumentPosition) => {
	const fileData = await getDocumentData(textDocumentPosition.textDocument.uri)
	const res: CompletionItem[] = []
	const callChain = findCallChain(fileData, textDocumentPosition.position, /*forAutocompletion*/true)
	if (callChain.length === 0)
		return res
	const call = callChain.length >= 2 ? callChain[callChain.length - 2] : callChain[callChain.length - 1] // ignore last key (obj.key - we need obj)
	let completionTdk = call.token ? call.token.tdk : call.tdk
	if (completionTdk.length > 0) {
		let typeDeclData = fileData.completion.typeDecls.find(td => td.tdk === completionTdk)
		if (typeDeclData != null) {
			let resTd = typeDeclCompletion(typeDeclData, fileData.completion, call.delimiter, call.brackets, res)
			if (resTd.tdk.length > 0)
				completionTdk = resTd.tdk
		}

		if (call.delimiter == Delimiter.Dot || call.delimiter == Delimiter.Pipe) {
			// fill extension functions
			for (const fn of fileData.completion.functions) {
				// TODO: ignore const cases: Foo const == Foo
				// TODO: convert dot to pipe
				if (fn.args.length > 0 && fn.args[0].tdk === completionTdk) {
					const c = CompletionItem.create(fn.name)
					c.detail = funcDetail(fn)
					c.documentation = funcDocs(fn)
					c.kind = CompletionItemKind.Function
					res.push(c)
				}
			}
		}
	}
	return res.length > 0 ? res : fileData.completionItems
})

connection.onHover(async (textDocumentPosition) => {
	const fileData = await getDocumentData(textDocumentPosition.textDocument.uri)
	if (!fileData)
		return null
	const callChain = findCallChain(fileData, textDocumentPosition.position, /*forAutocompletion*/false)
	if (callChain.length === 0)
		return null
	// console.log(JSON.stringify(callChain))
	const last = callChain[callChain.length - 1]
	const tok = last.token
	if (tok != null) {
		const settings = await getDocumentSettings(textDocumentPosition.textDocument.uri)

		let res = ""
		let first = true
		if (!first)
			res += "\n\n"
		first = false
		res += describeToken(tok)
		if (settings.hovers.verbose) {
			//
		}
		if (settings.experimental) {
			res += `\n// ${tok.kind}`
		}

		if (tok.kind == 'field') {
			res += `\n//^ ${tok.parentTdk}`
		}

		if (tok.kind == 'ExprCall' /* || tok.kind == 'func' */) {
			const func = fileData.completion.functions.find(f => f.name === tok.name && f.mod === tok.mod)
			if (func != null && func.cpp.length > 0)
				res += `\n[::${func.cpp}(...)]`
		}
		else if (tok.tdk.length > 0) {
			const showBaseType = tok.kind != 'ExprAddr'
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
		return {
			contents: { kind: 'markdown', value: "```dascript\n" + res + "\n```" },
			range: tok._range,
		}
	}
	const tdk = last.tdk
	if (tdk.length > 0) {
		for (const td of fileData.completion.typeDecls) {
			if (td.tdk === tdk) {
				const res = typeDeclDocs(td, fileData.completion)
				return { contents: { kind: 'markdown', value: "```dascript\n" + `${last.obj}\n${res}` + "\n```" } }
			}
		}
	}
	return null
})

connection.onTypeDefinition(async (typeDefinitionParams) => {
	const fileData = await getDocumentData(typeDefinitionParams.textDocument.uri)
	if (!fileData)
		return null
	const callChain = findCallChain(fileData, typeDefinitionParams.position, /*forAutocompletion*/false)
	if (callChain.length === 0)
		return null
	const last = callChain[callChain.length - 1]
	const resTdk = last.token ? last.token.tdk : last.tdk

	if (resTdk.length > 0) {
		for (const td of fileData.completion.typeDecls) {
			if (td.tdk === resTdk) {
				const pos = typeDeclDefinition(td, fileData.completion)
				if (pos._uri.length > 0 && !isRangeZeroEmpty(pos._range)) {
					return Location.create(pos._uri, pos._range)
				}
			}
		}
	}

	const res = last.token
	if (res != null) {
		// if (res.declAt._uri?.length != 0 && !isRangeZeroEmpty(res.declAt._range))
		// 	return Location.create(res.declAt._uri, res.declAt._range)		

		if (res.kind == "struct" || res.kind == "handle") {
			// it's fast :)
			const st = fileData.completion.structs.find(st => st.name === res.name && st.mod === res.mod)
			if (st != null) {
				const st2 = getParentStruct(st, fileData.completion)
				if (st2 != null && st2._uri.length > 0 && !isRangeZeroEmpty(st2._range)) {
					return Location.create(st2._uri, st2._range)
				}
			}
		}
	}
	return null
})

connection.onReferences(async (referencesParams) => {
	const fileData = await getDocumentData(referencesParams.textDocument.uri)
	if (!fileData)
		return null
	const callChain = findCallChain(fileData, referencesParams.position, /*forAutocompletion*/false)
	if (callChain.length === 0)
		return null
	const last = callChain[callChain.length - 1]
	const res = last.token
	// NOTE:! take in count declAt
	return null
})

// connection.onDeclaration(async (declarationParams) => {
// 	console.log("declaration", declarationParams)
// 	return null
// })
connection.onDefinition(async (declarationParams) => {
	const fileData = await getDocumentData(declarationParams.textDocument.uri)
	if (!fileData)
		return null
	const callChain = findCallChain(fileData, declarationParams.position, /*forAutocompletion*/false)
	if (callChain.length === 0)
		return null
	const last = callChain[callChain.length - 1]
	const res = last.token
	if (res != null) {
		if (res.declAt._uri?.length != 0 && !isRangeZeroEmpty(res.declAt._range))
			return Location.create(res.declAt._uri, res.declAt._range)

		if (res.kind == 'ExprAddr') {
			// function call
			const func = fileData.completion.functions.find(f => f.name === res.name && f.mod === res.mod)
			if (func != null && func.decl._uri.length > 0 && !isRangeZeroEmpty(func.decl._range))
				return Location.create(func._uri, func._range)
		}
		if (res.kind == "typedecl") {
			for (const td of fileData.completion.typeDecls) {
				if (td.tdk === res.tdk) {
					const pos = typeDeclDefinition(td, fileData.completion)
					if (pos._uri.length > 0 && !isRangeZeroEmpty(pos._range)) {
						return Location.create(pos._uri, pos._range)
					}
					break
				}
			}
		}

		if (res.kind == "ExprGoto") {
			// TODO: search label with same name
			// name === goto label 0 -> label 0
		}

		if (res.kind == "struct" || res.kind == "handle") {
			const childStructs: Location[] = []
			for (const st of fileData.completion.structs) {
				if (st.parentName === res.name && st.parentMod === res.mod && st._uri.length > 0 && !isRangeZeroEmpty(st._range)) {
					childStructs.push(Location.create(st._uri, st._range))
				}
			}
			if (childStructs.length > 0)
				return childStructs
		}
	}

	const parentTdk = res && res.parentTdk.length > 0 ? res.parentTdk : callChain.length > 1 ? callChain[callChain.length - 2].tdk : ""
	if (parentTdk.length > 0) {
		for (const td of fileData.completion.typeDecls) {
			if (td.tdk === parentTdk) {
				// TODO: find pos for field tdk.name
				const pos = typeDeclDefinition(td, fileData.completion)
				if (pos._uri.length > 0 && !isRangeZeroEmpty(pos._range)) {
					return Location.create(pos._uri, pos._range)
				}
			}
		}
	}
	return null
})

connection.onDocumentSymbol(async (documentSymbolParams) => {
	const fileData = await getDocumentData(documentSymbolParams.textDocument.uri)
	if (!fileData)
		return null
	const res: DocumentSymbol[] = []
	// TODO: add enums, typedefs, etc
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
			if (f.gen || f.name === "__rtti")
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
	for (const td of fileData.completion.typeDefs) {
		if (td._uri != documentSymbolParams.textDocument.uri)
			continue
		res.push({
			name: td.name,
			kind: SymbolKind.Interface,
			detail: typedefDetail(td),
			range: td._range,
			selectionRange: td._range,
		})
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
	// for (const tok of fileData.tokens) {
	// 	const fnToken = tok.kind == 'func'
	// 	if (!fnToken)
	// 		continue
	// 	if (tok._uri != documentSymbolParams.textDocument.uri)
	// 		continue

	// 	res.push({
	// 		name: tok.name,
	// 		detail: describeToken(tok),
	// 		kind: fnToken ? SymbolKind.Function : SymbolKind.Variable,
	// 		range: tok._range,
	// 		selectionRange: tok._range,
	// 	})
	// }
	return res
})

// connection.onCompletionResolve((item) => {
// 	return item
// })

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
	documents.all().forEach(validateTextDocument)
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

const validatingProcesses = new Map<string, ValidatingProcess>()

async function getDocumentData(uri: string): Promise<FixedValidationResult> {
	const data = validatingResults.get(uri)
	if (data)
		return data
	const loadingData = validatingProcesses.get(uri)
	if (loadingData) {
		return loadingData.promise.then(() => {
			return validatingResults.get(uri)
		})
	}
	return validateTextDocument(documents.get(uri)).then(() => {
		return validatingResults.get(uri)
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
	const fileVersion = textDocument.version
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
	const workspaceFolder = URI.parse(workspaceFolders![0].uri).fsPath
	for (const rootName in settings.project.fileAccessRoots) {
		const fixedRoot = settings.project.fileAccessRoots[rootName].replace('${workspaceFolder}', workspaceFolder)
		args.push('--file-access-root', `${rootName}:${fixedRoot}`)
	}

	const scriptPath = process.argv[1]
	const cwd = path.dirname(path.dirname(scriptPath))
	console.log(`validate ${textDocument.uri} version ${fileVersion}`)
	console.log('exec cmd', settings.compiler, args.join(' '), 'cwd', cwd)
	const vp: ValidatingProcess = { process: null, version: fileVersion, promise: null }
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
			console.log('remove temp files', tempFilePath, resultFilePath)
			fs.rmSync(tempFilePath)
			fs.rmSync(resultFilePath)

			if (documents.get(textDocument.uri)?.version !== fileVersion) {
				console.log('document version changed, ignoring result', textDocument.uri)
				return
			}

			// console.log(validateTextResult)
			let result: ValidationResult
			try {
				result = JSON.parse(validateTextResult) as ValidationResult
			}
			catch (e) {
				console.log('failed to parse result', e)
				console.log('"""', validateTextResult, '"""')
				if (exitCode === 0)
					diagnostics.get(textDocument.uri).push({ range: Range.create(0, 0, 0, 0), message: `internal error: failed to parse validation result. Please report this issue.` })
				return
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
				storeValidationResult(settings, textDocument.uri, result, exitCode, fileVersion)
			}
			if (exitCode !== 0 && diagnostics.get(textDocument.uri).length === 0) {
				diagnostics.get(textDocument.uri).push({ range: Range.create(0, 0, 0, 0), message: `internal error: Validation process exited with code ${exitCode}, but no errors were reported. Please report this issue.` })
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
	if (items.has(item.label)) {
		const it = items.get(item.label)
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

function storeValidationResult(settings: DasSettings, uri: string, res: ValidationResult, exitCode: any, fileVersion: integer) {
	const fixedResults: FixedValidationResult = { ...res, uri: uri, completionItems: [], fileVersion: fileVersion }
	if (res.errors.length > 0 || exitCode !== 0) {
		// keep previous completion items
		const prev = validatingResults.get(uri)
		if (prev) {
			fixedResults.completion = prev.completion
			fixedResults.completionItems = prev.completionItems
			fixedResults.tokens = prev.tokens
		}
	}
	else {
		const map = new Array<Map<string, CompletionItem>>()
		for (const e of res.completion.enums) {
			e._range = AtToRange(e)
			e._uri = AtToUri(e, uri, settings, res.dasRoot)
			addCompletionItem(map, {
				label: e.name,
				kind: CompletionItemKind.Enum,
				detail: enumDetail(e),
				documentation: enumDocs(e),
			})
			// fixedResults.tokens.push({
			// 	mod: e.mod,
			// 	line: e.line,
			// 	column: e.column,
			// 	lineEnd: e.lineEnd,
			// 	columnEnd: e.columnEnd,
			// 	file: e.file,
			// 	kind: 'ExprEnum',
			// 	name: e.name,
			// 	tdk: modPrefix(e.mod) + e.name,
			// 	value: '',
			// 	gen: false,
			// 	_range: e._range,
			// 	_uri: e._uri,
			// 	declAt: e,
			// })
			for (const ev of e.values) {
				ev._range = AtToRange(ev)
				ev._uri = AtToUri(ev, uri, settings, res.dasRoot)
				addCompletionItem(map, {
					label: ev.name,
					kind: CompletionItemKind.EnumMember,
					detail: enumValueDetail(ev),
					documentation: enumValueDocs(ev, e),
				})
				// fixedResults.tokens.push({
				// 	mod: e.mod,
				// 	line: ev.line,
				// 	column: ev.column,
				// 	lineEnd: ev.lineEnd,
				// 	columnEnd: ev.columnEnd,
				// 	file: ev.file,
				// 	kind: 'ExprEnumValue',
				// 	name: ev.name,
				// 	tdk: modPrefix(e.mod) + e.name,
				// 	value: '',
				// 	gen: false,
				// 	_range: ev._range,
				// 	_uri: ev._uri,
				// 	declAt: ev,
				// })
			}
		}
		for (const s of res.completion.structs) {
			s.column = Math.max(s.column - 5, 0) // magic number to fix column
			s._range = AtToRange(s)
			s._uri = AtToUri(s, uri, settings, res.dasRoot)
			addCompletionItem(map, {
				label: s.name,
				kind: s.isClass ? CompletionItemKind.Class : CompletionItemKind.Struct,
				detail: structDetail(s),
				documentation: structDocs(s),
			})
			for (const sf of s.fields) {
				// TODO: search for the field end using textDocument.getText()
				// sf.columnEnd += sf.tdk.length + 1 // 1 char for ':'
				sf._range = AtToRange(sf)
				sf._uri = AtToUri(sf, uri, settings, res.dasRoot)
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
			t._uri = AtToUri(t, uri, settings, res.dasRoot)
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
			t._uri = AtToUri(t, uri, settings, res.dasRoot)
			const valueType = res.completion.typeDecls.find(td => td.tdk === t.tdk)
			addCompletionItem(map, {
				label: t.name,
				kind: valueType != null ? baseTypeToCompletionItemKind(valueType.baseType) : CompletionItemKind.Struct,
				detail: typedefDetail(t),
				documentation: typedefDocs(t),
			})
		}
		for (const g of res.completion.globals) {
			g._range = AtToRange(g)
			g._uri = AtToUri(g, uri, settings, res.dasRoot)
			addCompletionItem(map, {
				label: g.name,
				kind: CompletionItemKind.Variable,
				detail: globalDetail(g),
				documentation: globalDocs(g),
			})
		}
		for (const f of res.completion.functions) {
			f._range = AtToRange(f)
			f._uri = AtToUri(f, uri, settings, res.dasRoot)
			f.decl._range = AtToRange(f.decl)
			f.decl._uri = AtToUri(f.decl, uri, settings, res.dasRoot)
			addCompletionItem(map, {
				label: f.name,
				kind: CompletionItemKind.Function,
				detail: funcDetail(f),
				documentation: funcDocs(f),
			})
			for (const arg of f.args) {
				arg._range = AtToRange(arg)
				arg._uri = AtToUri(arg, uri, settings, res.dasRoot)
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
			token._uri = AtToUri(token, uri, settings, res.dasRoot)
			if (token._uri != uri) // filter out tokens from other files
				continue
			if (token.kind == 'ExprField')
				token.columnEnd += token.name.length
			token._range = AtToRange(token)
			// declAt is negative for tokens that are not declared in the source code
			if (token.declAt.line >= 0) {
				token.declAt._range = AtToRange(token.declAt)
				token.declAt._uri = AtToUri(token.declAt, uri, settings, res.dasRoot)
			}
			else {
				token.declAt._range = Range.create(0, 0, 0, 0)
				token.declAt._uri = ""
			}
			fixedResults.tokens.push(token)
			// TODO: add completion items for tokens
			if (token.kind == 'ExprVar') {
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
					value: "```dascript\n" + item.documentation + "\n```"
				}
			}
		}
	}

	validatingResults.set(uri, fixedResults)
}

connection.listen()
