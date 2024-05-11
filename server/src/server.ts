
import {
	createConnection, TextDocuments, ProposedFeatures, TextDocumentSyncKind, WorkspaceFolder, DidChangeConfigurationNotification, integer, Range, Diagnostic, DiagnosticRelatedInformation, CompletionItem, CompletionItemKind, Hover, MarkupContent, Location, DiagnosticSeverity, SymbolKind, SymbolInformation,
	Position
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
import { AtToRange, AtToUri, DasToken, FixedValidationResult, ValidationResult, describeToken, enumDetail, enumDocs, enumValueDetail, enumValueDocs, funcArgDetail, funcArgDocs, funcDetail, funcDocs, getParentStruct, globalDetail, globalDocs, isPositionLess, isRangeLess, isRangeZeroEmpty, isValidIdChar, posInRange, primitiveBaseType, rangeCenter, structDetail, structDocs, structFieldDetail, structFieldDocs, typeDeclCompletion, typeDeclDefinition, typeDeclDetail, typeDeclDocs, typeDeclFieldDetail, typeDeclFieldDocs, typedefDetail, typedefDocs } from './completion'


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
}

function getCallChain(txt: TextDocument, pos: Position, forAutocompletion: boolean): CallChain[] {
	const line = txt.getText(Range.create(pos.line, 0, pos.line, pos.character))
	let i = line.length - 1
	// find key foo.key  foo().key  ... etc
	let key = ""
	for (; i >= 0; i--) {
		const ch = line[i]
		if (ch === ' ' || ch === '\t') {
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
		const text = txt.getText(Range.create(pos.line, pos.character, pos.line, pos.character + 100))
		for (let j = 0; j < text.length; j++) {
			const ch = text[j]
			if (isValidIdChar(ch))
				key += ch
			else
				break
		}
	}
	const keyRange = Range.create(pos.line, i + 1, pos.line, i + 1 + key.length)
	// skip spaces
	for (; i >= 0; i--) {
		const ch = line[i]
		if (ch !== ' ' && ch !== '\t')
			break
	}
	const keyData: CallChain = { obj: key, objRange: keyRange }

	let res: CallChain[] = [keyData]
	while (i > 0) {
		// '.' '?.' '->' 'as' 'is' '?as' '|>'
		const hasDot = i >= 0 && line[i] === '.'
		const hasMaybeDot = i > 0 && line[i] === '.' && line[i - 1] === '?'
		const hasArrow = i > 0 && line[i] === '>' && line[i - 1] === '-'
		const hasAs = i > 0 && line[i] === 's' && line[i - 1] === 'a'
		const hasIs = i > 0 && line[i] === 's' && line[i - 1] === 'i'
		const hasMaybeAs = i > 1 && line[i] === 's' && line[i - 1] === 'a' && line[i - 2] === '?'
		const hasPipe = i > 0 && line[i] === '>' && line[i - 1] === '|'
		if (!hasDot && !hasMaybeDot && !hasArrow && !hasAs && !hasIs && !hasMaybeAs && !hasPipe) {
			break
		}
		--i // ignore dot or space
		if (hasArrow || hasMaybeDot || hasAs || hasIs || hasMaybeAs || hasPipe) {
			--i
		}
		if (hasMaybeAs) {
			--i
		}
		// skip spaces
		for (; i >= 0; i--) {
			const ch = line[i]
			if (ch !== ' ' && ch !== '\t')
				break
		}


		let afterBracket = i >= 0 && (line[i] === ']' || line[i] === ')')
		if (afterBracket) {
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
		res.unshift({ obj: obj, objRange: objRange })
	}

	return res
}

connection.onCompletion(async (textDocumentPosition) => {
	const fileData = await getDocumentData(textDocumentPosition.textDocument.uri)
	const doc = documents.get(textDocumentPosition.textDocument.uri)
	const res: CompletionItem[] = []
	if (doc) {
		const completionToken = getCallChain(doc, textDocumentPosition.position, /*forAutocompletion*/true)
		console.log(JSON.stringify(completionToken))
		let completionTdk: string = ""
		if (completionToken.length > 1) {
			// TODO: resolve all chain nodes
			const objToken = completionToken[completionToken.length - 2]
			const tok = getDocumentTokensAt(fileData, objToken.obj, rangeCenter(objToken.objRange), /*exact match*/true)
			if (tok && tok.tdk.length > 0) {
				completionTdk = tok.tdk
				let typeDeclData = fileData.completion.typeDecls.find(td => td.tdk === tok.tdk)
				if (typeDeclData != null) {
					typeDeclCompletion(typeDeclData, fileData.completion, res)
				}
			}
		}
		else if (completionToken.length > 0) {
			// probably enum
			const enumData = fileData.completion.enums.find(e => e.name === completionToken[0].obj)
			if (enumData != null) {
				completionTdk = enumData.tdk
				for (const ev of enumData.values) {
					const c = CompletionItem.create(ev.name)
					c.detail = enumValueDetail(ev)
					c.documentation = enumValueDocs(ev, enumData)
					c.kind = CompletionItemKind.EnumMember
					res.push(c)
				}
			}
		}
		if (completionTdk != "") {
			// fill extension functions
			for (const fn of fileData.completion.functions) {
				// TODO: ignore const cases: Foo const == Foo
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
	return res.length > 0 ? res : fileData?.completionItems
	// return fileData?.completionItems ?? []
})

function getDocumentTokensAt(fileData: FixedValidationResult, name: string, position: Position, exactMatch = false): DasToken {
	if (name.length === 0 || fileData.tokens.length === 0)
		return null
	let nearestPos = Position.create(0, 0)
	let resToken: DasToken
	for (let index = 0; index < fileData.tokens.length; index++) {
		const t = fileData.tokens[index]
		if (t.name === name && t._uri == fileData.uri && isPositionLess(t._range.start, position) && isPositionLess(nearestPos, t._range.start)) {
			nearestPos = t._range.start
			resToken = t
			continue
		}
	}
	if (resToken != null) {
		return resToken
	}
	// maybe we have exact match somewhere
	const exactName = fileData.tokens.find(t => t.name === name && t._uri != fileData.uri)
	if (exactName != null)
		return exactName
	if (exactMatch)
		return null
	// lets try to find any token in given range
	const res: DasToken[] = []
	for (const tok of fileData.tokens) {
		if (tok._uri == fileData.uri && posInRange(position, tok._range)) {
			res.push(tok)
		}
	}
	if (res.length === 0)
		return null
	res.sort((a, b) => {
		return isRangeLess(a._range, b._range) ? -1 : 1
	})
	return res[0]
}

connection.onHover(async (textDocumentPosition) => {
	const fileData = await getDocumentData(textDocumentPosition.textDocument.uri)
	if (!fileData)
		return null
	const doc = documents.get(textDocumentPosition.textDocument.uri)
	const callChain = getCallChain(doc, textDocumentPosition.position, /*forAutocompletion*/false)
	// TODO: resolve all chain nodes
	const tok = callChain.length == 1 ? getDocumentTokensAt(fileData, callChain[0].obj, rangeCenter(callChain[0].objRange)) : null
	if (tok == null)
		return null
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
})

connection.onTypeDefinition(async (typeDefinitionParams) => {
	const fileData = await getDocumentData(typeDefinitionParams.textDocument.uri)
	if (!fileData)
		return null
	const doc = documents.get(typeDefinitionParams.textDocument.uri)
	if (!doc)
		return null
	const callChain = getCallChain(doc, typeDefinitionParams.position, /*forAutocompletion*/false)
	const res = callChain.length == 1 ? getDocumentTokensAt(fileData, callChain[0].obj, rangeCenter(callChain[0].objRange)) : null
	if (res == null)
		return null

	// if (res.declAt._uri?.length != 0 && !isRangeZeroEmpty(res.declAt._range))
	// 	return Location.create(res.declAt._uri, res.declAt._range)

	if (res.tdk.length > 0) {
		for (const td of fileData.completion.typeDecls) {
			if (td.tdk === res.tdk) {
				const pos = typeDeclDefinition(td, fileData.completion)
				if (pos._uri.length > 0 && !isRangeZeroEmpty(pos._range)) {
					return Location.create(pos._uri, pos._range)
				}
			}
		}
	}

	if (res.kind == "struct") {
		// it's fast :)
		const st = fileData.completion.structs.find(st => st.name === res.name && st.mod === res.mod)
		if (st != null) {
			const st2 = getParentStruct(st, fileData.completion)
			if (st2 != null && st2._uri.length > 0 && !isRangeZeroEmpty(st2._range)) {
				return Location.create(st2._uri, st2._range)
			}
		}
	}
	return null
})

connection.onReferences(async (referencesParams) => {
	const fileData = await getDocumentData(referencesParams.textDocument.uri)
	if (!fileData)
		return null
	const doc = documents.get(referencesParams.textDocument.uri)
	if (!doc)
		return null
	const callChain = getCallChain(doc, referencesParams.position, /*forAutocompletion*/false)
	const res = callChain.length == 1 ? getDocumentTokensAt(fileData, callChain[0].obj, rangeCenter(callChain[0].objRange)) : null
	if (res == null)
		return null
	console.log("references", referencesParams, res)
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
	const doc = documents.get(declarationParams.textDocument.uri)
	if (!doc)
		return null
	const callChain = getCallChain(doc, declarationParams.position, /*forAutocompletion*/false)
	const res = callChain.length == 1 ? getDocumentTokensAt(fileData, callChain[0].obj, rangeCenter(callChain[0].objRange)) : null
	if (res == null)
		return null

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

	if (res.parentTdk.length > 0) {
		for (const td of fileData.completion.typeDecls) {
			if (td.tdk === res.parentTdk) {
				// TODO: find pos for field tdk.name
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

	if (res.kind == "struct") {
		const childStructs: Location[] = []
		for (const st of fileData.completion.structs) {
			if (st.parentName === res.name && st.parentMod === res.mod && st._uri.length > 0 && !isRangeZeroEmpty(st._range)) {
				childStructs.push(Location.create(st._uri, st._range))
			}
		}
		if (childStructs.length > 0)
			return childStructs
	}
	return null
})

connection.onDocumentSymbol(async (documentSymbolParams) => {
	const fileData = await getDocumentData(documentSymbolParams.textDocument.uri)
	if (!fileData)
		return null
	const res: SymbolInformation[] = []
	// TODO: add structures, enums, typedefs, etc
	// TODO: use DocumentSymbol to support nested structures
	for (const st of fileData.completion.structs) {
		if (st._uri != documentSymbolParams.textDocument.uri)
			continue
		res.push({
			name: st.name,
			kind: st.isClass ? SymbolKind.Class : SymbolKind.Struct,
			location: Location.create(st._uri, st._range),
			containerName: st.parentName,
		})
		for (const f of st.fields) {
			res.push({
				name: f.name,
				kind: SymbolKind.Field,
				location: Location.create(f._uri, f._range),
				containerName: st.name,
			})
		}
	}
	for (const tok of fileData.tokens) {
		const fnToken = tok.kind == 'func'
		if (!fnToken)
			continue
		if (tok._uri != documentSymbolParams.textDocument.uri)
			continue

		res.push({
			name: describeToken(tok),
			kind: fnToken ? SymbolKind.Function : SymbolKind.Variable,
			location: Location.create(tok._uri, tok._range),
			containerName: tok.mod,
		})
	}
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
let validateTempDir = null

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
		return prevProcess.promise
	}
	const fileVersion = textDocument.version
	const settings = await getDocumentSettings(textDocument.uri)

	const filePath = URI.parse(textDocument.uri).fsPath
	const tempFileName = `${stringHashCode(textDocument.uri).toString(16)}_${validateId.toString(16)}_${textDocument.version.toString(16)}_${path.basename(filePath)}`
	validateId++
	if (validateTempDir == null)
		validateTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'das_validate_'))
	const tempFilePath = path.join(validateTempDir, tempFileName)
	await fs.promises.writeFile(tempFilePath, textDocument.getText())

	const args = settings.server.args.map(arg => arg.replace('${file}', 'validate_file.das'))
	if (args.indexOf('--') < 0)
		args.push('--')
	args.push('--file', tempFilePath)
	args.push('--original-file', filePath)
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

		let validateTextResult = ''
		const diagnostics: Map<string, Diagnostic[]> = new Map()
		diagnostics.set(textDocument.uri, [])
		child.stdout.on('data', (data: any) => {
			validateTextResult += data
		})
		child.stderr.on('data', (data: any) => {
			diagnostics.get(textDocument.uri).push({ range: Range.create(0, 0, 0, 0), message: `${data}` })
		})
		child.on('error', (error: any) => {
			diagnostics.get(textDocument.uri).push({ range: Range.create(0, 0, 0, 0), message: `${error}` })
			reject(error)
		})
		child.on('close', (exitCode: any) => {
			console.log('remove temp file', tempFilePath)
			fs.rmSync(tempFilePath)

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
					error._uri = AtToUri(error, textDocument.uri, settings)

					const diag: Diagnostic = { range: error._range, message: error.what, code: error.cerr, severity: error.level === 0 ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning }
					if (error.extra?.length > 0 || error.fixme?.length > 0) {
						let extra = error.extra || ''
						if (error.fixme?.length > 0)
							extra += extra.length > 0 ? `\n${error.fixme}` : error.fixme
						const lines = extra.split('\n')
						const info: DiagnosticRelatedInformation[] = []
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
				console.log('"""', validateTextResult, '"""')
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
			e._uri = AtToUri(e, uri, settings)
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
				ev._uri = AtToUri(ev, uri, settings)
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
			s._uri = AtToUri(s, uri, settings)
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
			t._uri = AtToUri(t, uri, settings)
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
			t._uri = AtToUri(t, uri, settings)
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
			g._uri = AtToUri(g, uri, settings)
			addCompletionItem(map, {
				label: g.name,
				kind: CompletionItemKind.Variable,
				detail: globalDetail(g),
				documentation: globalDocs(g),
			})
		}
		for (const f of res.completion.functions) {
			f._range = AtToRange(f)
			f._uri = AtToUri(f, uri, settings)
			f.decl._range = AtToRange(f.decl)
			f.decl._uri = AtToUri(f.decl, uri, settings)
			addCompletionItem(map, {
				label: f.name,
				kind: CompletionItemKind.Function,
				detail: funcDetail(f),
				documentation: funcDocs(f),
			})
			for (const arg of f.args) {
				arg._range = AtToRange(arg)
				arg._uri = AtToUri(arg, uri, settings)
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
			token._uri = AtToUri(token, uri, settings)
			if (token._uri != uri) // filter out tokens from other files
				continue
			if (token.kind == 'ExprField')
				token.columnEnd += token.name.length
			token._range = AtToRange(token)
			// declAt is negative for tokens that are not declared in the source code
			if (token.declAt.line >= 0) {
				token.declAt._range = AtToRange(token.declAt)
				token.declAt._uri = AtToUri(token.declAt, uri, settings)
			}
			else {
				token.declAt._range = Range.create(0, 0, 0, 0)
				token.declAt._uri = ""
			}
			fixedResults.tokens.push(token)
			// TODO: add completion items for tokens
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
