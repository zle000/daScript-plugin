
import {
	createConnection, TextDocuments, ProposedFeatures, TextDocumentSyncKind, WorkspaceFolder, DidChangeConfigurationNotification, integer, Range, Diagnostic, DiagnosticRelatedInformation, CompletionItem, CompletionItemKind, Hover, MarkupContent, Location, DiagnosticSeverity, SymbolKind, SymbolInformation
} from 'vscode-languageserver/node'

import {
	Position,
	TextDocument
} from 'vscode-languageserver-textdocument'

import { URI } from 'vscode-uri'
import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import path = require('path')
import fs = require('fs')
import os = require('os')


function modPrefix(mod: string) {
	if (mod.length === 0)
		return ''
	return mod + '::'
}

interface DasError extends CompletionAt {
	what: string,
	extra: string,
	fixme: string,
	cerr: integer,
	level: integer, // 0 error, 1 warning
}

interface DasToken extends CompletionAt {
	kind: string
	name: string
	alias: string
	value: string
	mod: string
	tdk: string
	parentTdk: string // only when kind == 'field'
	isUnused: boolean // todo: show warning
	isConst: boolean
	declAt: CompletionAt
}

function describeToken(tok: DasToken) {
	let res = ""
	if (tok.kind == 'ExprCall' || tok.kind == 'func')
		res += tok.value
	else if (tok.kind == 'struct')
		res += `struct ${tok.name}`
	else if (tok.kind == 'typedecl')
		res += tok.tdk
	else {
		const hasValue = tok.value?.length > 0
		const hasTdk = tok.tdk?.length > 0
		if (hasValue && hasTdk)
			res += `${tok.name} : ${tok.tdk} = ${tok.value}`
		else if (hasValue)
			res += `${tok.name} = ${tok.value}`
		else if (hasTdk)
			res += `${tok.name} : ${tok.tdk}`
		else
			res += tok.name
	}

	if (tok.alias.length > 0)
		res += ` aka ${tok.alias}`

	if (tok.kind == 'ExprVar' || tok.kind == 'ExprLet')
		res = (tok.isConst ? 'let ' : 'var ') + res
	return res
}

interface CompletionAt {
	file: string
	line: integer
	column: integer
	lineEnd: integer
	columnEnd: integer

	_range: Range
	_uri: string
}

interface CompletionEnumValue extends CompletionAt {
	name: string
	value: string
}

function enumValueDetail(ev: CompletionEnumValue) {
	return `${ev.name} = ${ev.value}`
}

function enumValueDocs(ev: CompletionEnumValue, e: CompletionEnum) {
	return `${modPrefix(e.mod)}${e.name} ${ev.name} = ${ev.value}`
}

interface CompletionEnum extends CompletionAt {
	name: string
	mod: string
	cpp: string
	baseType: string
	values: CompletionEnumValue[]
}

function enumDetail(e: CompletionEnum) {
	return `enum ${e.name} : ${e.baseType}`
}

function enumDocs(e: CompletionEnum) {
	return `enum ${modPrefix(e.mod)}${e.name} : ${e.baseType}\n${e.values.map(v => `  ${v.name} = ${v.value}`).join('\n')}`
}

interface CompletionGlobal extends CompletionAt {
	name: string
	tdk: string
	value: string
	mod: string
	gen: boolean
	isUnused: boolean // TODO: show warning
}

function globalDetail(g: CompletionGlobal) {
	return `${g.name} = ${g.value}`
}

function globalDocs(g: CompletionGlobal) {
	return `${modPrefix(g.mod)}${g.name} = ${g.value}`
}

interface CompletionStructField extends CompletionAt {
	name: string
	tdk: string
	offset: integer
	isPrivate: boolean
	gen: boolean
}

function structFieldDetail(sf: CompletionStructField) {
	return `${sf.name}: ${sf.tdk}`
}

function structFieldDocs(sf: CompletionStructField, s: CompletionStruct) {
	return `${modPrefix(s.mod)}${s.name}.${sf.name}: ${sf.tdk}`
}

interface CompletionStruct extends CompletionAt {
	name: string
	mod: string
	parentName: string
	parentMod: string
	fields: CompletionStructField[]
	isClass: boolean
	isLambda: boolean
	isMacro: boolean
	isGenerator: boolean
	gen: boolean
}

function structParentSuffix(parentName: string) {
	if (parentName.length === 0)
		return ''
	return ` : ${parentName}`
}

function structDetail(s: CompletionStruct) {
	return `struct ${s.name}${structParentSuffix(s.parentName)}`
}

function structDocs(s: CompletionStruct) {
	return `struct ${modPrefix(s.mod)}${s.name}${structParentSuffix(s.parentName)}\n${s.fields.map(f => `  ${f.name}: ${f.tdk}`).join('\n')}`
}

function getParentStruct(s: CompletionStruct, cr: CompletionResult): CompletionStruct | null {
	if (s.parentName.length === 0)
		return null
	return cr.structs.find(st => st.name === s.parentName && st.mod === s.parentMod)
}

interface CompletionTypeDeclField {
	name: string
	tdk: string
}

function typeDeclFieldDetail(tf: CompletionTypeDeclField) {
	return `${tf.name}: ${tf.tdk}`
}

function typeDeclFieldDocs(tf: CompletionTypeDeclField, t: CompletionTypeDecl) {
	return `${modPrefix(t.mod)}${t.tdk}.${tf.name}: ${tf.tdk}`
}

interface CompletionTypeDecl extends CompletionAt {
	baseType: string
	tdk: string
	fields: CompletionTypeDeclField[]
	dim: integer[]
	alias: string
	sizeOf: integer
	alignOf: integer
	enumName: string
	structName: string
	mod: string // enum or struct mod
	tdk1: string
	tdk2: string
}

function typeDeclDetail(td: CompletionTypeDecl) {
	return td.tdk
}

function typeDeclDefinition(td: CompletionTypeDecl, cr: CompletionResult): CompletionAt {
	if (td.baseType === 'structure') {
		const st = cr.structs.find(s => s.name === td.structName && s.mod === td.mod)
		if (st)
			return st
		else
			console.error(`typeDeclDefinition: failed to find struct ${td.structName} in ${td.mod}`)
	}
	// enum with zero name == unspecified enumeration const
	if (td.baseType === 'enum' && td.enumName.length > 0) {
		const en = cr.enums.find(e => e.name === td.enumName && e.mod === td.mod)
		if (en)
			return en
		else
			console.error(`typeDeclDefinition: failed to find enum ${td.enumName} in ${td.mod}`)
	}
	// if (td.baseType === 'function') {
	// 	const func = cr.functions.find(f => f.name === td.tdk && f.mod === td.mod)
	// 	if (func)
	// 		return func.decl
	// 	else
	// 		console.error(`typeDeclDefinition: failed to find function ${td.tdk} in ${td.mod}`)
	// }
	// pointer with empty tdk1 is void, array with empty tdk1 is unspecified array
	if ((td.baseType === 'pointer' || td.baseType === 'array') && td.tdk1.length > 0) {
		const td1 = cr.typeDecls.find(t => t.tdk === td.tdk1)
		if (td1)
			return typeDeclDefinition(td1, cr)
		else
			console.error(`typeDeclDefinition: failed to find type ${td.tdk1}`)
	}
	// table with empty tdk2 is unspecified table
	if (td.baseType === 'table' && td.tdk1.length > 0) {
		const td2 = cr.typeDecls.find(t => t.tdk === td.tdk2)
		if (td2)
			return typeDeclDefinition(td2, cr)
		else
			console.error(`typeDeclDefinition: failed to find type ${td.tdk2}`)
	}
	return td
}

function primitiveBaseType(td: CompletionTypeDecl, cr: CompletionResult): boolean {
	if (td.baseType === 'pointer') {
		const td1 = cr.typeDecls.find(t => t.tdk === td.tdk1)
		if (td1)
			return primitiveBaseType(td1, cr)
		else
			console.error(`primitiveBaseType: failed to find type ${td.tdk1}`)
	}
	const t = td.baseType
	return !(t == "structure" || t == "bitfield" || t == "alias" || t == "any" || t == "auto" || t == "<context>" || t == "<line info>" || t == "option" || t == "enum" || t == "enum8" || t == "enum16" || t == "function" || t == "handle" || t == "pointer" || t == "block" || t == "iterator" || t == "lambda" || t == "variant" || t == "tuple" || t == "array" || t == "table")
}

// TODO: print dim size
function typeDeclDocs(td: CompletionTypeDecl, cr: CompletionResult): string {
	if (td.baseType === 'structure') {
		const st = cr.structs.find(s => s.name === td.structName && s.mod === td.mod)
		if (st)
			return structDocs(st)
		else
			console.error(`typeDeclDocs: failed to find struct ${td.structName} in ${td.mod}`)
	}
	// enum with zero name == unspecified enumeration const
	if (td.baseType === 'enum' && td.enumName.length > 0) {
		const en = cr.enums.find(e => e.name === td.enumName && e.mod === td.mod)
		if (en)
			return enumDocs(en)
		else
			console.error(`typeDeclDocs: failed to find enum ${td.enumName} in ${td.mod}`)
	}
	// if (td.baseType === 'function') {
	// 	const func = cr.functions.find(f => modPrefix(f.mod) + f.name === td.tdk)
	// 	if (func)
	// 		return funcDocs(func)
	// 	else
	// 		console.error(`typeDeclDocs: failed to find function ${td.tdk} in ${td.mod}`)
	// }
	// pointer with empty tdk1 is void, array with empty tdk1 is unspecified array
	if ((td.baseType === 'pointer' || td.baseType === 'array') && td.tdk1.length > 0) {
		const td1 = cr.typeDecls.find(t => t.tdk === td.tdk1)
		if (td1)
			return typeDeclDocs(td1, cr)
		else
			console.error(`typeDeclDocs: failed to find type ${td.tdk1}`)
	}
	// table with empty tdk2 is unspecified table
	if (td.baseType === 'table' && td.tdk1.length > 0) {
		const td2 = cr.typeDecls.find(t => t.tdk === td.tdk2)
		if (td2)
			return typeDeclDocs(td2, cr)
		else
			console.error(`typeDeclDocs: failed to find type ${td.tdk2}`)
	}
	let res = `${modPrefix(td.mod)}${td.tdk}`
	if (td.baseType != td.tdk)
		res += ` // ${td.baseType}` // TODO: remove this part
	// TODO: variant, tuple
	if (td.fields.length > 0)
		res += `\n${td.fields.map(f => `  ${f.name}: ${f.tdk}`).join('\n')}`

	return res
}


function typeDeclCompletion(td: CompletionTypeDecl, cr: CompletionResult, res: CompletionItem[]): void {
	if (td.baseType === 'structure') {
		const st = cr.structs.find(s => s.name === td.structName && s.mod === td.mod)
		if (st) {
			st.fields.forEach(f => {
				const c = CompletionItem.create(f.name)
				c.kind = CompletionItemKind.Field
				c.detail = structFieldDetail(f)
				c.documentation = structFieldDocs(f, st)
				res.push(c)
			})
		}
		else
			console.error(`typeDeclDefinition: failed to find struct ${td.structName} in ${td.mod}`)
	}
	// enum with zero name == unspecified enumeration const
	if (td.baseType === 'enum' && td.enumName.length > 0) {
		const en = cr.enums.find(e => e.name === td.enumName && e.mod === td.mod)
		if (en) {
			en.values.forEach(v => {
				const c = CompletionItem.create(v.name)
				c.kind = CompletionItemKind.EnumMember
				c.detail = enumValueDetail(v)
				c.documentation = enumValueDocs(v, en)
				res.push(c)
			})
		}
		else
			console.error(`typeDeclDefinition: failed to find enum ${td.enumName} in ${td.mod}`)
	}
	// if (td.baseType === 'function') {
	// 	const func = cr.functions.find(f => f.name === td.tdk && f.mod === td.mod)
	// 	if (func)
	// 		return func.decl
	// 	else
	// 		console.error(`typeDeclDefinition: failed to find function ${td.tdk} in ${td.mod}`)
	// }
	// pointer with empty tdk1 is void, array with empty tdk1 is unspecified array
	if ((td.baseType === 'pointer' || td.baseType === 'array') && td.tdk1.length > 0) {
		const td1 = cr.typeDecls.find(t => t.tdk === td.tdk1)
		if (td1)
			typeDeclCompletion(td1, cr, res)
		else
			console.error(`typeDeclDefinition: failed to find type ${td.tdk1}`)
	}
	// table with empty tdk2 is unspecified table
	if (td.baseType === 'table' && td.tdk1.length > 0) {
		const td2 = cr.typeDecls.find(t => t.tdk === td.tdk2)
		if (td2)
			typeDeclCompletion(td2, cr, res)
		else
			console.error(`typeDeclDefinition: failed to find type ${td.tdk2}`)
	}
	// return td
	td.fields.forEach(f => {
		const c = CompletionItem.create(f.name)
		c.kind = CompletionItemKind.Field
		c.detail = typeDeclFieldDetail(f)
		c.documentation = typeDeclFieldDocs(f, td)
		res.push(c)
	})
}


interface CompletionTypeDef extends CompletionAt {
	name: string
	tdk: string
}

function typedefDetail(t: CompletionTypeDef) {
	return `typedef ${t.name} = ${t.tdk}`
}

function typedefDocs(t: CompletionTypeDef) {
	return `typedef ${t.name} = ${t.tdk}`
}

interface CompletionFuncArg extends CompletionAt {
	name: string
	alias: string
	tdk: string
	value: string
}

function funcArgDetail(a: CompletionFuncArg) {
	const val = (a.alias.length > 0) ? `${a.name} aka ${a.alias} : ${a.tdk}` : `${a.name} : ${a.tdk}`
	if (a.value.length > 0)
		return `${val} = ${a.value}`
	return val
}

function funcArgDocs(a: CompletionFuncArg) {
	return funcArgDetail(a)
}

interface CompletionFunction extends CompletionAt {
	name: string
	mod: string
	cpp: string
	tdk: string
	decl: CompletionAt
	args: CompletionFuncArg[]
	gen: boolean
}

function funcRetTypeSuffix(retType: string) {
	return retType.length === 0 ? '' : ` : ${retType}`
}

function funcDetail(f: CompletionFunction) {
	return `def ${f.name}(${f.args.map(a => `${a.name}: ${a.tdk}`).join('; ')})${funcRetTypeSuffix(f.tdk)}`
}

function funcDocs(f: CompletionFunction) {
	let res = `def ${f.name}(${f.args.map(a => `${a.name}: ${a.tdk}`).join('; ')})${funcRetTypeSuffix(f.tdk)}`
	if (f.cpp.length > 0)
		res += `\n[::${f.cpp}(...)]`
	return res
}

interface CompletionResult {
	enums: CompletionEnum[]
	structs: CompletionStruct[]
	typeDecls: CompletionTypeDecl[]
	typeDefs: CompletionTypeDef[]
	globals: CompletionGlobal[]
	functions: CompletionFunction[]
}

interface ValidationResult {
	errors: DasError[]
	tokens: DasToken[]
	completion: CompletionResult
}

function AtToUri(at: CompletionAt, documentUri: string, settings: DasSettings) {
	if (at.file?.length == 0)
		return ""

	if (fs.existsSync(at.file)) {
		return URI.file(at.file).toString()
	}

	for (const dir of settings.project.roots) {
		const full = path.join(dir, at.file)
		if (fs.existsSync(full)) {
			return URI.file(full).toString()
		}
	}

	for (const dir of ['daslib', 'src/builtin']) {
		const full = path.join(dir, at.file)
		if (fs.existsSync(full)) {
			return URI.file(full).toString()
		}
	}

	return URI.file(at.file).toString()
}

function AtToRange(at: CompletionAt) {
	const res = Range.create(
		Math.max(0, at.line - 1), at.column,
		Math.max(0, at.lineEnd - 1), at.columnEnd
	)
	if (res.end.character > 0 && at.line === at.lineEnd)
		res.end.character += 1 // magic, don't ask, it works
	return res
}

interface FixedValidationResult extends ValidationResult {
	uri: string
	fileVersion: integer
	completionItems: CompletionItem[]
}

function posInRange(pos: Position, range: Range) {
	return isPositionLessOrEqual(range.start, pos) && isPositionLessOrEqual(pos, range.end)
}

function isRangeLess(a: Range, b: Range) {
	const lenA = a.end.line - a.start.line
	const lenB = b.end.line - b.start.line
	if (lenA < lenB)
		return true
	if (lenA > lenB)
		return false
	const lenA2 = a.end.character - a.start.character
	const lenB2 = b.end.character - b.start.character
	return (lenA2 < lenB2)
}

function isRangeZeroEmpty(a: Range) {
	return (a.start.line === 0 && a.start.character === 0 && a.end.line === 0 && a.end.character === 0)
}

function isPositionLess(a: Position, b: Position) {
	if (a.line < b.line)
		return true
	if (a.line > b.line)
		return false
	return a.character < b.character
}

function isPositionLessOrEqual(a: Position, b: Position) {
	if (a.line < b.line)
		return true
	if (a.line > b.line)
		return false
	return a.character <= b.character
}


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
			// referencesProvider: true,
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

function prevToken(txt: TextDocument, pos: Position): { obj: string; objRange: Range; key?: string; keyRange?: Range; afterBracket: boolean } {
	const line = txt.getText(Range.create(pos.line, 0, pos.line, pos.character))
	let key = ""
	let obj = ""
	let afterBracket = false

	let i = line.length - 1
	// find key foo.key  foo().key  ... etc
	for (; i >= 0; i--) {
		const ch = line[i]
		if (ch === ' ' || ch === '\t') {
			if (key.length === 0)
				continue
			break
		}
		if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_' || ch === '`')
			key = ch + key
		else
			break
	}
	const keyRange = Range.create(pos.line, i + 1, pos.line, i + 1 + key.length)
	// skip spaces
	for (; i >= 0; i--) {
		const ch = line[i]
		if (ch !== ' ' && ch !== '\t')
			break
	}
	const hasDot = i >= 0 && line[i] === '.'
	const hasSpace = i >= 0 && (line[i] === ' ') // enum?
	if (!hasDot && !hasSpace) {
		return { obj: key, objRange: keyRange, afterBracket: false }
	}
	i-- // ignore dot or space
	// skip spaces
	for (; i >= 0; i--) {
		const ch = line[i]
		if (ch !== ' ' && ch !== '\t')
			break
	}

	afterBracket = i >= 0 && (line[i] === ']' || line[i] === ')')
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

	for (; i >= 0; i--) {
		const ch = line[i]
		if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_' || ch === '`')
			obj = ch + obj
		else
			break
	}
	const objRange = Range.create(pos.line, i + 1, pos.line, i + 1 + obj.length)

	return { obj: obj, objRange: objRange, key: key, keyRange: keyRange, afterBracket }
}

connection.onCompletion(async (textDocumentPosition) => {
	const fileData = await getDocumentData(textDocumentPosition.textDocument.uri)
	const doc = documents.get(textDocumentPosition.textDocument.uri)
	const res: CompletionItem[] = []
	if (doc) {
		const completionToken = prevToken(doc, textDocumentPosition.position)
		// console.log('text', JSON.stringify(token))
		if (completionToken.obj.length > 0) {
			{
				const tokens = getDocumentTokensAt(fileData, completionToken.objRange.start)
				let tok = tokens.find(t => t.name === completionToken.obj)
				if (!tok) {
					// fallback logic, look up for similar tokens
					let cursorPos: integer = 0
					for (let index = 0; index < fileData.tokens.length; index++) {
						const t = fileData.tokens[index]
						if (isPositionLess(t._range.end, completionToken.objRange.start)) {
							cursorPos = index
							continue
						}
					}
					for (let index = cursorPos; index >= 0; index--) {
						const t = fileData.tokens[index]
						if (t.kind == 'func' || t.kind == 'struct' || t.kind == 'enum') // top level tokens
							break
						if (t.name === completionToken.obj) {
							tok = t // probably found
							break
						}
					}
				}
				if (tok && tok.tdk.length > 0) {
					for (const td of fileData.completion.typeDecls) {
						if (td.tdk === tok.tdk) {
							typeDeclCompletion(td, fileData.completion, res)
							break
							// res.push(CompletionItem.create(td.tdk))
							// if (!primitiveBaseType(td, fileData.completion)) {

							// }
						}
					}
					for (const fn of fileData.completion.functions) {
						if (fn.args.length > 0 && fn.args[0].tdk === tok.tdk) {
							const c = CompletionItem.create(fn.name)
							c.detail = funcDetail(fn)
							c.documentation = funcDocs(fn)
							c.kind = CompletionItemKind.Function
							res.push(c)
						}
					}
				}
			}
		}
	}
	return res.length > 0 ? res : fileData?.completionItems
	// return fileData?.completionItems ?? []
})

function getDocumentTokensAt(fileData: FixedValidationResult, position: Position): DasToken[] {
	const res: DasToken[] = []
	for (const tok of fileData.tokens) {
		if (tok._uri != fileData.uri)
			continue
		if (posInRange(position, tok._range)) {
			res.push(tok)
		}
	}
	res.sort((a, b) => {
		return isRangeLess(a._range, b._range) ? -1 : 1
	})
	// for (const st of fileData.completion.structs) {
	// 	if (st.gen)
	// 		continue
	// 	if (st._uri != uri)
	// 		continue
	// 	if ((res == null || isRangeLess(st._range, resRange)) && posInRange(position, st._range)) {
	// 		res = struct_docs(st)
	// 		resUri = st._uri
	// 		// resTdk = modPrefix(st.mod) + st.name // struct is already contains all required info
	// 		resRange = st._range
	// 		resDeclUri = st._uri
	// 	}
	// 	for (const stf of st.fields) {
	// 		if ((res == null || isRangeLess(stf._range, resRange)) && posInRange(position, stf._range)) {
	// 			res = struct_field_docs(stf, st)
	// 			resUri = stf._uri
	// 			resTdk = stf.tdk
	// 			resRange = stf._range
	// 			resDeclUri = stf._uri
	// 		}
	// 	}
	// 	for (const g of fileData.completion.globals) {
	// 		if (g.gen)
	// 			continue
	// 		if (g._uri != uri)
	// 			continue
	// 		if ((res == null || isRangeLess(g._range, resRange)) && posInRange(position, g._range)) {
	// 			res = global_docs(g)
	// 			resUri = g._uri
	// 			resTdk = g.tdk
	// 			resRange = g._range
	// 			resDeclUri = g._uri
	// 		}
	// 	}
	// 	for (const func of fileData.completion.functions) {
	// 		if (func.gen)
	// 			continue
	// 		if (func._uri != uri)
	// 			continue
	// 		if ((res == null || isRangeLess(func._range, resRange)) && posInRange(position, func._range)) {
	// 			res = funcDocs(func)
	// 			resTdk = func.tdk
	// 			resUri = func._uri
	// 			resRange = func._range
	// 			resDecl = func._declRange
	// 			resDeclUri = func._declUri
	// 		}
	// 		for (const arg of func.args) {
	// 			if (arg._uri != uri)
	// 				continue
	// 			if ((res == null || isRangeLess(arg._range, resRange)) && posInRange(position, arg._range)) {
	// 				res = `${arg.name}: ${arg.tdk}`
	// 				resTdk = arg.tdk
	// 				resUri = arg._uri
	// 				resRange = arg._range
	// 				resDeclUri = arg._uri
	// 			}
	// 		}
	// 	}
	// 	// for (const td of fileData.completion.typeDecls) {
	// 	// 	if ((res == null || isRangeLess(td._range, res.range)) && posInRange(textDocumentPosition.position, td._range)) {
	// 	// 		res = {
	// 	// 			contents: { kind: 'markdown', value: "```dascript\n" + type_decl_docs(td) + "\n```" },
	// 	// 			range: td._range
	// 	// 		}
	// 	// 	}
	// 	// }
	// 	for (const td of fileData.completion.typeDefs) {
	// 		if (td._uri != uri)
	// 			continue
	// 		if ((res == null || isRangeLess(td._range, resRange)) && posInRange(position, td._range)) {
	// 			res = typedefDocs(td)
	// 			resTdk = td.tdk
	// 			resUri = td._uri
	// 			resRange = td._range
	// 			resDeclUri = td._uri
	// 		}
	// 	}
	// 	for (const e of fileData.completion.enums) {
	// 		if (e._uri != uri)
	// 			continue
	// 		if ((res == null || isRangeLess(e._range, resRange)) && posInRange(position, e._range)) {
	// 			res = enum_docs(e)
	// 			resMod = e.mod
	// 			resTdk = e.name
	// 			resUri = e._uri
	// 			resRange = e._range
	// 			resDeclUri = e._uri
	// 		}
	// 		for (const ev of e.values) {
	// 			if (ev._uri != uri)
	// 				continue
	// 			if ((res == null || isRangeLess(ev._range, resRange)) && posInRange(position, ev._range)) {
	// 				res = enumValueDocs(ev, e)
	// 				resMod = e.mod
	// 				resTdk = ev.name
	// 				resUri = ev._uri
	// 				resRange = ev._range
	// 				resDeclUri = ev._uri
	// 			}
	// 		}
	// 	}
	// }
	return res
}

connection.onHover(async (textDocumentPosition) => {
	const fileData = await getDocumentData(textDocumentPosition.textDocument.uri)
	if (!fileData)
		return null
	const toks = getDocumentTokensAt(fileData, textDocumentPosition.position)
	if (toks.length == 0)
		return null
	const settings = await getDocumentSettings(textDocumentPosition.textDocument.uri)

	let res = ""
	let first = true
	for (const tok of toks) {
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
	}
	return {
		contents: { kind: 'markdown', value: "```dascript\n" + res + "\n```" },
		range: toks[0]._range,
	}
})

connection.onTypeDefinition(async (typeDefinitionParams) => {
	const fileData = await getDocumentData(typeDefinitionParams.textDocument.uri)
	if (!fileData)
		return null
	const tokens = getDocumentTokensAt(fileData, typeDefinitionParams.position)
	const res = tokens.length > 0 ? tokens[0] : null
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

// connection.onReferences(async (referencesParams) => {
// 	console.log("references", referencesParams)
// 	return null
// })

// connection.onDeclaration(async (declarationParams) => {
// 	console.log("declaration", declarationParams)
// 	return null
// })
connection.onDefinition(async (declarationParams) => {
	const fileData = await getDocumentData(declarationParams.textDocument.uri)
	if (!fileData)
		return null
	const tokens = getDocumentTokensAt(fileData, declarationParams.position)
	const res = tokens.length > 0 ? tokens[0] : null
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

interface DasSettings {
	compiler: string,
	server: {
		args: string[],
		unity?: boolean,
	},
	project?: {
		file?: string,
		scanWorkspace?: boolean,
		roots?: string[],
		fileAccessRoots?: { [key: string]: string },
	}
	hovers?: {
		verbose?: boolean,
	},
	policies?: {
		ignore_shared_modules?: boolean,
		no_global_variables?: boolean,
		no_unused_block_arguments?: boolean,
		no_unused_function_arguments?: boolean,
		fail_on_lack_of_aot_export?: boolean,
	},
	debug?: {
		port: integer,
	},
	experimental?: boolean,
}

const defaultSettings: DasSettings = {
	compiler: "daScript", server: { args: ["${file}", "--", "--port", "${port}"] },
	policies: { ignore_shared_modules: true, }
}
let globalSettings = defaultSettings

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<DasSettings>> = new Map()

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
