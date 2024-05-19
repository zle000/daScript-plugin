import { CompletionItem, CompletionItemKind, Location, Position, Range, integer } from 'vscode-languageserver/node'
import { DasSettings } from './dasSettings'
import fs = require('fs')
import path = require('path')
import { URI } from 'vscode-uri'

export enum BaseType {
    none = 'none',
    autoinfer = 'auto',
    alias = 'alias',
    option = 'option',
    fakeContext = '<context>',
    fakeLineInfo = '<line info>',
    anyArgument = 'any',
    tVoid = 'void',
    tBool = 'bool',
    tInt8 = 'int8',
    tInt16 = 'int16',
    tUInt8 = 'uint8',
    tUInt16 = 'uint16',
    tInt64 = 'int64',
    tUInt64 = 'uint64',
    tInt = 'int',
    tInt2 = 'int2',
    tInt3 = 'int3',
    tInt4 = 'int4',
    tUInt = 'uint',
    tUInt2 = 'uint2',
    tUInt3 = 'uint3',
    tUInt4 = 'uint4',
    tFloat = 'float',
    tFloat2 = 'float2',
    tFloat3 = 'float3',
    tFloat4 = 'float4',
    tDouble = 'double',
    tRange = 'range',
    tURange = 'urange',
    tRange64 = 'range64',
    tURange64 = 'urange64',
    tString = 'string',
    tStructure = 'structure',
    tHandle = 'handle',
    tEnumeration = 'enum',
    tEnumeration8 = 'enum8',
    tEnumeration16 = 'enum16',
    tBitfield = 'bitfield',
    tPointer = 'pointer',
    tFunction = 'function',
    tLambda = 'lambda',
    tIterator = 'iterator',
    tArray = 'array',
    tTable = 'table',
    tBlock = 'block',
    tTuple = 'tuple',
    tVariant = 'variant',
}

export function baseTypeIsEnum(bt: BaseType) {
    return bt === BaseType.tEnumeration || bt === BaseType.tEnumeration8 || bt === BaseType.tEnumeration16
}

export enum TokenKind {
    ExprCall = 'ExprCall',
    Func = 'func',
    Struct = 'struct',
    Typedecl = 'typedecl',
    ExprVar = 'ExprVar',
    ExprLet = 'ExprLet',
    Field = 'field',
    Handle = 'handle',
    ExprAddr = 'ExprAddr',
    ExprGoto = 'ExprGoto',
    ExprField = 'ExprField',
}

export function isValidIdChar(ch: string) {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_' || ch === '`'
}

export function isSpaceChar(ch: string) {
    return ch === ' ' || ch === '\t'
}

function modPrefix(mod: string) {
    if (mod.length === 0)
        return ''
    return mod + '::'
}


export interface DasError extends CompletionAt {
    what: string,
    extra: string,
    fixme: string,
    cerr: integer,
    level: integer, // 0 error, 1 warning
}

export interface DasToken extends CompletionAt {
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

export function describeToken(tok: DasToken) {
    // cursed code, but it works
    let res = ''
    if (tok.kind == TokenKind.ExprCall || tok.kind == TokenKind.Func)
        res += tok.value
    else if (tok.kind == TokenKind.Struct || tok.kind == TokenKind.Handle)
        res += `struct ${tok.name}`
    else if (tok.kind == TokenKind.Typedecl)
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

    if (tok.kind == TokenKind.ExprVar || tok.kind == TokenKind.ExprLet)
        res = (tok.isConst ? 'let ' : 'var ') + res
    return res
}

export interface CompletionAt {
    file: string
    line: integer
    column: integer
    lineEnd: integer
    columnEnd: integer

    _range: Range
    _uri: string
}

export function addValidLocation(res: Location[], at: CompletionAt): void {
    if (at != null && at._uri.length > 0 && !isRangeZeroEmpty(at._range))
        res.push(Location.create(at._uri, at._range))
}

export interface CompletionEnumValue extends CompletionAt {
    name: string
    value: string
}

export function enumValueDetail(ev: CompletionEnumValue) {
    return `${ev.name} = ${ev.value}`
}

export function enumValueDocs(ev: CompletionEnumValue, e: CompletionEnum) {
    return `${modPrefix(e.mod)}${e.name} ${ev.name} = ${ev.value}`
}

export interface CompletionEnum extends CompletionAt {
    name: string
    mod: string
    cpp: string
    tdk: string
    baseType: string
    values: CompletionEnumValue[]
}

export function enumDetail(e: CompletionEnum) {
    return `enum ${e.name} : ${e.baseType}`
}

export function enumDocs(e: CompletionEnum) {
    return `enum ${modPrefix(e.mod)}${e.name} : ${e.baseType}\n${e.values.map(v => `  ${v.name} = ${v.value}`).join('\n')}`
}

export interface CompletionGlobal extends CompletionAt {
    name: string
    tdk: string
    value: string
    mod: string
    gen: boolean
    isUnused: boolean // TODO: show warning
}

export function globalDetail(g: CompletionGlobal) {
    return `${g.name} = ${g.value}`
}

export function globalDocs(g: CompletionGlobal) {
    return `${modPrefix(g.mod)}${g.name} = ${g.value}`
}

export interface CompletionStructField extends CompletionAt {
    name: string
    tdk: string
    offset: integer
    isPrivate: boolean
    gen: boolean
}

export function structFieldDetail(sf: CompletionStructField) {
    return `${sf.name}: ${sf.tdk}`
}

export function structFieldDocs(sf: CompletionStructField, s: CompletionStruct) {
    return `${modPrefix(s.mod)}${s.name}.${sf.name}: ${sf.tdk}`
}

export interface CompletionStruct extends CompletionAt {
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

export function structParentSuffix(parentName: string) {
    if (parentName.length === 0)
        return ''
    return ` : ${parentName}`
}

export function structDetail(s: CompletionStruct) {
    return `struct ${s.name}${structParentSuffix(s.parentName)}`
}

export function structDocs(s: CompletionStruct) {
    return `struct ${modPrefix(s.mod)}${s.name}${structParentSuffix(s.parentName)}\n${s.fields.map(f => `  ${f.name}: ${f.tdk}`).join('\n')}`
}

export function getParentStruct(s: CompletionStruct, cr: CompletionResult): CompletionStruct | null {
    if (s.parentName.length === 0)
        return null
    return cr.structs.find(st => st.name === s.parentName && st.mod === s.parentMod)
}

export interface CompletionTypeDeclField {
    name: string
    tdk: string
}

export function typeDeclFieldDetail(tf: CompletionTypeDeclField) {
    return `${tf.name}: ${tf.tdk}`
}

export function typeDeclFieldDocs(tf: CompletionTypeDeclField, t: CompletionTypeDecl) {
    return `${modPrefix(t.mod)}${t.tdk}.${tf.name}: ${tf.tdk}`
}

export interface CompletionTypeDecl extends CompletionAt {
    baseType: BaseType
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
export
    function typeDeclDetail(td: CompletionTypeDecl) {
    return td.tdk
}

export function typeDeclDefinition(td: CompletionTypeDecl, cr: CompletionResult): CompletionAt {
    if ((td.baseType === BaseType.tStructure || td.baseType === BaseType.tHandle) && td.dim.length == 0) {
        const st = cr.structs.find(s => s.name === td.structName && s.mod === td.mod)
        if (st)
            return st
        else
            console.error(`typeDeclDefinition: failed to find struct ${td.structName} in ${td.mod}`)
    }
    // enum with zero name == unspecified enumeration const
    if (baseTypeIsEnum(td.baseType) && td.dim.length == 0 && td.enumName.length > 0) {
        const en = cr.enums.find(e => e.name === td.enumName && e.mod === td.mod)
        if (en)
            return en
        else
            console.error(`typeDeclDefinition: failed to find enum ${td.enumName} in ${td.mod}`)
    }
    // if (td.baseType === BaseType.tFunction) {
    // 	const func = cr.functions.find(f => f.name === td.tdk && f.mod === td.mod)
    // 	if (func)
    // 		return func.decl
    // 	else
    // 		console.error(`typeDeclDefinition: failed to find function ${td.tdk} in ${td.mod}`)
    // }
    // pointer with empty tdk1 is void, array with empty tdk1 is unspecified array
    if ((td.baseType === BaseType.tPointer || td.baseType === BaseType.tArray || td.dim.length > 0) && td.tdk1.length > 0) {
        const td1 = cr.typeDecls.find(t => t.tdk === td.tdk1)
        if (td1)
            return typeDeclDefinition(td1, cr)
        else
            console.error(`typeDeclDefinition: failed to find type ${td.tdk1}`)
    }
    // table with empty tdk2 is unspecified table
    if (td.baseType === BaseType.tTable && td.dim.length == 0 && td.tdk1.length > 0) {
        const td2 = cr.typeDecls.find(t => t.tdk === td.tdk2)
        if (td2)
            return typeDeclDefinition(td2, cr)
        else
            console.error(`typeDeclDefinition: failed to find type ${td.tdk2}`)
    }
    return td
}

export function primitiveBaseType(td: CompletionTypeDecl, cr: CompletionResult): boolean {
    if (td.baseType === BaseType.tPointer || td.dim.length > 0) {
        const td1 = cr.typeDecls.find(t => t.tdk === td.tdk1)
        if (td1)
            return primitiveBaseType(td1, cr)
        else
            console.error(`primitiveBaseType: failed to find type ${td.tdk1}`)
    }
    const t = td.baseType
    return !(
        t == BaseType.tStructure ||
        t == BaseType.tBitfield ||
        t == BaseType.alias ||
        t == BaseType.anyArgument ||
        t == BaseType.autoinfer ||
        t == BaseType.fakeContext ||
        t == BaseType.fakeLineInfo ||
        t == BaseType.option ||
        t == BaseType.tEnumeration ||
        t == BaseType.tEnumeration8 ||
        t == BaseType.tEnumeration16 ||
        t == BaseType.tFunction ||
        t == BaseType.tHandle ||
        t == BaseType.tPointer ||
        t == BaseType.tBlock ||
        t == BaseType.tIterator ||
        t == BaseType.tLambda ||
        t == BaseType.tVariant ||
        t == BaseType.tTuple ||
        t == BaseType.tArray ||
        t == BaseType.tTable
    )
}

export function typeDeclIter(td: CompletionTypeDecl, cr: CompletionResult, cb: (td: CompletionTypeDecl, st: CompletionStruct, en: CompletionEnum) => void): void {
    if ((td.baseType === BaseType.tStructure || td.baseType === BaseType.tHandle) && td.dim.length == 0) {
        const st = cr.structs.find(s => s.name === td.structName && s.mod === td.mod)
        if (st)
            return cb(td, st, null)
        else
            console.error(`typeDeclDocs: failed to find struct ${td.structName} in ${td.mod}`)
    }
    // enum with zero name == unspecified enumeration const
    if (baseTypeIsEnum(td.baseType) && td.dim.length == 0 && td.enumName.length > 0) {
        const en = cr.enums.find(e => e.name === td.enumName && e.mod === td.mod)
        if (en)
            return cb(td, null, en)
        else
            console.error(`typeDeclDocs: failed to find enum ${td.enumName} in ${td.mod}`)
    }
    // if (td.baseType === BaseType.tFunction) {
    // 	const func = cr.functions.find(f => modPrefix(f.mod) + f.name === td.tdk)
    // 	if (func)
    // 		return funcDocs(func)
    // 	else
    // 		console.error(`typeDeclDocs: failed to find function ${td.tdk} in ${td.mod}`)
    // }
    // pointer with empty tdk1 is void, array with empty tdk1 is unspecified array
    // if ((td.baseType === BaseType.tPointer || td.baseType === BaseType.tArray || td.dim.length > 0) && td.tdk1.length > 0) {
    if (td.tdk1.length > 0) {
        const td1 = cr.typeDecls.find(t => t.tdk === td.tdk1)
        if (td1)
            return typeDeclIter(td1, cr, cb)
        else
            console.error(`typeDeclDocs: failed to find type ${td.tdk1}`)
    }
    // table with empty tdk2 is unspecified table
    // if (td.baseType === BaseType.tTable && td.dim.length == 0 && td.tdk2.length > 0) {
    if (td.tdk2.length > 0) {
        const td2 = cr.typeDecls.find(t => t.tdk === td.tdk2)
        if (td2)
            return typeDeclIter(td2, cr, cb)
        else
            console.error(`typeDeclDocs: failed to find type ${td.tdk2}`)
    }
}

// TODO: print dim size
export function typeDeclDocs(td: CompletionTypeDecl, cr: CompletionResult): string {
    let res = ''
    typeDeclIter(td, cr, function (td, st, en) {
        if (st)
            res += structDocs(st)
        if (en)
            res += enumDocs(en)
    })

    if (res.length == 0) {
        res = `${modPrefix(td.mod)}${td.tdk}`
        if (td.baseType != td.tdk)
            res += ` // ${td.baseType}` // TODO: remove this part
        // TODO: variant, tuple
        if (td.fields.length > 0)
            res += `\n${td.fields.map(f => `  ${f.name}: ${f.tdk}`).join('\n')}`
    }

    return res
}

// returns actual CompletionTypeDecl
export function typeDeclCompletion(td: CompletionTypeDecl, cr: CompletionResult, delimiter: Delimiter, brackets: Brackets, res: CompletionItem[]): CompletionTypeDecl {
    let resultTd = td
    if ((td.baseType === BaseType.tStructure || td.baseType === BaseType.tHandle) && td.dim.length == 0 && brackets != Brackets.Square) {
        const st = cr.structs.find(s => s.name === td.structName && s.mod === td.mod)
        if (st) {
            st.fields.forEach(f => {
                // TODO: show fields only when delimiter is dot, show functions only when delimiter is arrow or auto transform completion text
                const c = CompletionItem.create(f.name)
                c.kind = CompletionItemKind.Field
                c.detail = structFieldDetail(f)
                c.documentation = structFieldDocs(f, st)
                c.data = f.tdk
                res.push(c)
            })
        }
        else
            console.error(`typeDeclDefinition: failed to find struct ${td.structName} in ${td.mod}`)
    }
    // enum with zero name == unspecified enumeration const
    if (baseTypeIsEnum(td.baseType) && td.dim.length == 0 && td.enumName.length > 0 && brackets != Brackets.Square) {
        const en = cr.enums.find(e => e.name === td.enumName && e.mod === td.mod)
        if (en) {
            en.values.forEach(v => {
                const c = CompletionItem.create(v.name)
                c.kind = CompletionItemKind.EnumMember
                c.detail = enumValueDetail(v)
                c.documentation = enumValueDocs(v, en)
                c.data = en.tdk
                res.push(c)
            })
        }
        else
            console.error(`typeDeclDefinition: failed to find enum ${td.enumName} in ${td.mod}`)
    }
    // if (td.baseType === BaseType.tFunction) {
    // 	const func = cr.functions.find(f => f.name === td.tdk && f.mod === td.mod)
    // 	if (func)
    // 		return func.decl
    // 	else
    // 		console.error(`typeDeclDefinition: failed to find function ${td.tdk} in ${td.mod}`)
    // }
    // pointer with empty tdk1 is void, array with empty tdk1 is unspecified array
    if ((td.baseType === BaseType.tPointer || ((td.baseType === BaseType.tArray || td.dim.length > 0) && brackets == Brackets.Square)) && td.tdk1.length > 0) {
        const td1 = cr.typeDecls.find(t => t.tdk === td.tdk1)
        if (td1)
            resultTd = typeDeclCompletion(td1, cr, Delimiter.None, Brackets.None, res)
        else
            console.error(`typeDeclDefinition: failed to find type ${td.tdk1}`)
    }
    // table with empty tdk2 is unspecified table
    if (td.baseType === BaseType.tTable && brackets == Brackets.Square && td.dim.length == 0 && td.tdk1.length > 0) {
        const td2 = cr.typeDecls.find(t => t.tdk === td.tdk2)
        if (td2)
            resultTd = typeDeclCompletion(td2, cr, Delimiter.None, Brackets.None, res)
        else
            console.error(`typeDeclDefinition: failed to find type ${td.tdk2}`)
    }
    // return td
    const asIs = delimiter == Delimiter.As || delimiter == Delimiter.Is || delimiter == Delimiter.QuestionAs
    if (asIs == (resultTd.baseType === BaseType.tVariant) && resultTd.dim.length == 0) {
        resultTd.fields.forEach(f => {

            const c = CompletionItem.create(f.name)
            c.kind = CompletionItemKind.Field
            c.detail = typeDeclFieldDetail(f)
            c.documentation = typeDeclFieldDocs(f, resultTd)
            c.data = f.tdk
            res.push(c)
        })
    }
    if (td.baseType == BaseType.tFloat2 || td.baseType == BaseType.tFloat3 || td.baseType == BaseType.tFloat4
        || td.baseType == BaseType.tInt2 || td.baseType == BaseType.tInt3 || td.baseType == BaseType.tInt4 || td.baseType == BaseType.tRange
        || td.baseType == BaseType.tUInt2 || td.baseType == BaseType.tUInt3 || td.baseType == BaseType.tUInt4 || td.baseType == BaseType.tURange
    ) {
        let dim = td.baseType.endsWith('4') ? 4 : td.baseType.endsWith('3') ? 3 : 2
        let type = td.baseType.startsWith('f') ? BaseType.tFloat : td.baseType.startsWith('u') ? BaseType.tUInt : BaseType.tInt
        if (brackets != Brackets.Square) {
            const fieldsStr = 'xyzw'
            for (let i = 0; i < dim; i++) {
                const c = CompletionItem.create(fieldsStr.charAt(i))
                c.kind = CompletionItemKind.Field
                c.detail = `${c.label} : ${type}`
                c.data = type
                res.push(c)
            }
        }
        const td2 = cr.typeDecls.find(t => t.tdk === type)
        if (td2)
            resultTd = typeDeclCompletion(td2, cr, Delimiter.None, Brackets.None, res)
    }
    else if (td.baseType == BaseType.tRange64) {
        const td2 = cr.typeDecls.find(t => t.tdk === BaseType.tInt64)
        if (td2)
            resultTd = typeDeclCompletion(td2, cr, Delimiter.None, Brackets.None, res)
    }
    else if (td.baseType == BaseType.tURange64) {
        const td2 = cr.typeDecls.find(t => t.tdk === BaseType.tUInt64)
        if (td2)
            resultTd = typeDeclCompletion(td2, cr, Delimiter.None, Brackets.None, res)
    }
    return resultTd
}

export interface CompletionTypeDef extends CompletionAt {
    name: string
    tdk: string
}

export function typedefDetail(t: CompletionTypeDef) {
    return `typedef ${t.name} = ${t.tdk}`
}

export function typedefDocs(t: CompletionTypeDef) {
    return `typedef ${t.name} = ${t.tdk}`
}

export interface CompletionFuncArg extends CompletionAt {
    name: string
    alias: string
    tdk: string
    value: string
}

export function funcArgDetail(a: CompletionFuncArg) {
    const val = (a.alias.length > 0) ? `${a.name} aka ${a.alias} : ${a.tdk}` : `${a.name} : ${a.tdk}`
    if (a.value.length > 0)
        return `${val} = ${a.value}`
    return val
}

export function funcArgDocs(a: CompletionFuncArg) {
    return funcArgDetail(a)
}

export interface CompletionFunction extends CompletionAt {
    name: string
    mod: string
    cpp: string
    tdk: string
    decl: CompletionAt
    args: CompletionFuncArg[]
    gen: boolean
    isClassMethod: boolean
}

function funcRetTypeSuffix(retType: string) {
    return retType.length === 0 ? '' : ` : ${retType}`
}

export function funcDetail(f: CompletionFunction) {
    return `def ${f.name}(${f.args.map(a => `${a.name}: ${a.tdk}`).join('; ')})${funcRetTypeSuffix(f.tdk)}`
}

export function funcDocs(f: CompletionFunction) {
    let res = `def ${f.name}(${f.args.map(a => `${a.name}: ${a.tdk}`).join('; ')})${funcRetTypeSuffix(f.tdk)}`
    if (f.cpp.length > 0)
        res += `\n[::${f.cpp}(...)]`
    return res
}

export interface CompletionResult {
    enums: CompletionEnum[]
    structs: CompletionStruct[]
    typeDecls: CompletionTypeDecl[]
    typeDefs: CompletionTypeDef[] // aliases, typedef Foo = int
    globals: CompletionGlobal[]
    functions: CompletionFunction[]
}

export interface ValidationResult {
    errors: DasError[]
    tokens: DasToken[]
    completion: CompletionResult
    dasRoot: string
}

export function AtToUri(at: CompletionAt, documentUri: string, settings: DasSettings, dasRoot: string) {
    if (at.file?.length == 0)
        return ''

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
        const full = path.join(dasRoot, dir, at.file)
        if (fs.existsSync(full)) {
            return URI.file(full).toString()
        }
    }

    return URI.file(at.file).toString()
}

export function AtToRange(at: CompletionAt) {
    const res = Range.create(
        Math.max(0, at.line - 1), at.column,
        Math.max(0, at.lineEnd - 1), at.columnEnd
    )
    if (res.end.character > 0 && at.line === at.lineEnd)
        res.end.character += 1 // magic, don't ask, it works
    return res
}

export interface FixedValidationResult extends ValidationResult {
    uri: string
    fileVersion: integer
    completionItems: CompletionItem[]
}

export function posInRange(pos: Position, range: Range) {
    return isPositionLessOrEqual(range.start, pos) && isPositionLessOrEqual(pos, range.end)
}

export function rangeCenter(range: Range): Position {
    return Position.create(
        Math.round((range.start.line + range.end.line) / 2),
        Math.round((range.start.character + range.end.character) / 2)
    )
}

export function isRangeLess(a: Range, b: Range) {
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

export function isRangeEqual(a: Range, b: Range) {
    return isPositionEqual(a.start, b.start) && isPositionEqual(a.end, b.end)
}

export function isRangeZeroEmpty(a: Range) {
    return (a.start.line === 0 && a.start.character === 0 && a.end.line === 0 && a.end.character === 0)
}

export function isPositionLess(a: Position, b: Position) {
    if (a.line < b.line)
        return true
    if (a.line > b.line)
        return false
    return a.character < b.character
}

export function isPositionLessOrEqual(a: Position, b: Position) {
    if (a.line < b.line)
        return true
    if (a.line > b.line)
        return false
    return a.character <= b.character
}

export function isPositionEqual(a: Position, b: Position) {
    return a.line == b.line && a.character == b.character
}

export enum Delimiter {
    None = '',
    Space = ' ',
    Dot = '.',
    Arrow = '->',
    QuestionDot = '?.',
    As = 'as',
    Is = 'is',
    QuestionAs = '?as',
    Pipe = '|>',
}

export enum Brackets {
    None = 0,
    Round = 1,
    Square = 2,
}
