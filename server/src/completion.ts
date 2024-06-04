import { TextDocument } from 'vscode-languageserver-textdocument'
import { CompletionItem, CompletionItemKind, Location, Position, Range, integer } from 'vscode-languageserver/node'
import { URI } from 'vscode-uri'
import { DasSettings } from './dasSettings'
import fs = require('fs')
import path = require('path')


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
    ColonColon = '::',
}

export enum Brackets {
    None = 0,
    Round = 1,
    Square = 2,
    QuestionSquare = 3,
}

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
    ExprLabel = 'ExprLabel',
    ExprField = 'ExprField',
    FuncArg = 'func_arg',
    BlockArg = 'block_arg',
    ExprFor = 'ExprFor',
    ExprAssume = 'ExprAssume',
    ExprDebug = 'ExprDebug',
    ExprConstEnumeration = 'ExprConstEnumeration',
    Require = 'require',
}

export function isValidIdChar(ch: string) {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_' || ch === '`'
}

export function isSpaceChar(ch: string) {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
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

export function describeToken(tok: DasToken, cr: CompletionResult) {
    // cursed code, but it works
    let res = ''
    if (tok.kind == TokenKind.ExprGoto)
        res += `goto ${tok.name}`
    else if (tok.kind == TokenKind.ExprLabel)
        res += `label ${tok.name}`
    else if (tok.kind == TokenKind.Require)
        res += tok._originalText
    else if (tok.kind == TokenKind.ExprCall || tok.kind == TokenKind.Func)
        res += tok.value
    else if (tok.kind == TokenKind.Struct || tok.kind == TokenKind.Handle) {
        const st = cr.structs.find(s => s.name === tok.name && s.mod === tok.mod)
        if (st)
            res += structDetail(st)
        else
            res += `struct ${tok.name}`
    }
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
    _originalText: string
}

export function isValidLocation(at: CompletionAt): boolean {
    return at._uri.length > 0 && !isRangeZeroEmpty(at._range)
}

export function addValidLocation(res: Location[], at: CompletionAt): void {
    if (at != null && isValidLocation(at))
        res.push(Location.create(at._uri, at._range))
}

export function addUniqueLocation(res: Location[], at: CompletionAt): void {
    if (at != null && isValidLocation(at)) {
        const loc = Location.create(at._uri, at._range)
        if (!res.some(l => l.uri === loc.uri && isRangeOverlap(l.range, loc.range)))
            res.push(loc)
    }
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

    _readFn: CompletionFunction // currently exists only for properties
    _writeFn: CompletionFunction // currently exists only for properties
    _property: boolean
}

export function structFieldDetail(sf: CompletionStructField) {
    let res = `${sf.name}: ${sf.tdk}`
    if (sf._property) {
        if (sf._readFn && sf._writeFn)
            res += ` [r/w]`
        else if (sf._writeFn)
            res += ` [w/o]`
        else
            res += ` [r/o]`
    }
    return res
}

export function structFieldDocs(sf: CompletionStructField, s: CompletionStruct) {
    let res = `${modPrefix(s.mod)}${s.name}.${sf.name}: ${sf.tdk}`
    if (sf._property) {
        if (sf._readFn && sf._writeFn)
            res = `[r/w operator]\n${res}`
        else if (sf._writeFn)
            res = `[w/o operator]\n${res}`
        else
            res = `[r/o operator]\n${res}`

        if (sf._readFn && sf._readFn.cpp.length > 0)
            res += `\n[::${sf._readFn.cpp}(...)]`

        if (sf._writeFn && sf._writeFn.cpp.length > 0)
            res += `\n[::${sf._writeFn.cpp}(...)]`
    }
    return res
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
    return `struct ${modPrefix(s.mod)}${s.name}${structParentSuffix(s.parentName)}\n${s.fields.map(f => `  ${structFieldDetail(f)}`).join('\n')}`
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

export function typeDeclDetail(td: CompletionTypeDecl) {
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
    if (td.alias.length > 0) {
        const td1 = cr.typeDefs.find(t => t.name === td.alias && t.mod === td.mod)
        if (td1)
            return td1
        // else
        //     console.error(`typeDeclDefinition: failed to find type ${td.alias} in ${td.mod}`)
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

export function typeDeclIter(td: CompletionTypeDecl, cr: CompletionResult, cb: (td: CompletionTypeDecl, st: CompletionStruct, en: CompletionEnum, tf: CompletionTypeDef) => void): void {
    if ((td.baseType === BaseType.tStructure || td.baseType === BaseType.tHandle) && td.dim.length == 0) {
        const st = cr.structs.find(s => s.name === td.structName && s.mod === td.mod)
        if (st)
            return cb(td, st, null, null)
        else
            console.error(`typeDeclDocs: failed to find struct ${td.structName} in ${td.mod}`)
    }
    // enum with zero name == unspecified enumeration const
    if (baseTypeIsEnum(td.baseType) && td.dim.length == 0 && td.enumName.length > 0) {
        const en = cr.enums.find(e => e.name === td.enumName && e.mod === td.mod)
        if (en)
            return cb(td, null, en, null)
        else
            console.error(`typeDeclDocs: failed to find enum ${td.enumName} in ${td.mod}`)
    }
    if (td.alias.length > 0) {
        const td1 = cr.typeDefs.find(t => t.name === td.alias && t.mod === td.mod)
        if (td1)
            cb(td, null, null, td1)
        // else
        //     console.error(`typeDeclDocs: failed to find type ${td.alias} in ${td.mod}`)
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
    typeDeclIter(td, cr, function (td2, st, en, tf) {
        if (st)
            res += `${res.length > 0 ? '\n\n' : ''}${structDocs(st)}`
        if (en)
            res += `${res.length > 0 ? '\n\n' : ''}${enumDocs(en)}`
        if (tf)
            res += `${res.length > 0 ? '\n\n' : ''}${typedefDocs(tf)}`
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

export const FIELD_SORT = '0'
export const PROPERTY_SORT = '1'
export const METHOD_SORT = '2'
export const EXTENSION_FN_SORT = '3'
export const OPERATOR_SORT = '4'

function addUniqueCompletionItem(res: CompletionItem[], c: CompletionItem) {
    if (!res.some(ci => ci.label === c.label))
        res.push(c)
}

// returns actual CompletionTypeDecl
export function typeDeclCompletion(td: CompletionTypeDecl, cr: CompletionResult, delimiter: Delimiter, brackets: Brackets, res: CompletionItem[]): CompletionTypeDecl {
    return typeDeclCompletion_(td, cr, delimiter, brackets, 0, res)
}
function typeDeclCompletion_(td: CompletionTypeDecl, cr: CompletionResult, delimiter: Delimiter, brackets: Brackets, depth: number, res: CompletionItem[]): CompletionTypeDecl {
    if (depth > 50) {
        console.error(`typeDeclCompletion: recursion depth exceeded for ${td.tdk}`)
        return td
    }
    let resultTd = td
    const dotDel = delimiter == Delimiter.Dot || delimiter == Delimiter.None
    const qDotDel = delimiter == Delimiter.QuestionDot
    const spaceDel = delimiter == Delimiter.Space
    if ((td.baseType === BaseType.tStructure || td.baseType === BaseType.tHandle) && td.dim.length == 0 && brackets != Brackets.Square && brackets != Brackets.QuestionSquare) {
        const st = cr.structs.find(s => s.name === td.structName && s.mod === td.mod)
        if (st) {
            const onlyFunctions = delimiter == Delimiter.Arrow
            if (onlyFunctions || dotDel || qDotDel)
                st.fields.forEach(f => {
                    const td = cr.typeDecls.find(t => t.tdk === f.tdk)
                    const isFunction = !f._property && td && td.baseType === BaseType.tFunction
                    if (onlyFunctions && !isFunction)
                        return
                    const c = CompletionItem.create(f.name)
                    if (onlyFunctions)
                        c.insertText = `->${f.name}(`
                    c.kind = isFunction ? CompletionItemKind.Reference : f._property ? CompletionItemKind.Property : CompletionItemKind.Field
                    c.detail = structFieldDetail(f)
                    c.documentation = structFieldDocs(f, st)
                    c.data = f.tdk
                    c.sortText = isFunction ? METHOD_SORT : f._property ? PROPERTY_SORT : FIELD_SORT
                    addUniqueCompletionItem(res, c)
                })
        }
        else
            console.error(`typeDeclDefinition: failed to find struct ${td.structName} in ${td.mod}`)
    }
    // enum with zero name == unspecified enumeration const
    if (baseTypeIsEnum(td.baseType) && td.dim.length == 0 && td.enumName.length > 0 && (dotDel || spaceDel) && brackets != Brackets.Square && brackets != Brackets.QuestionSquare) {
        const en = cr.enums.find(e => e.name === td.enumName && e.mod === td.mod)
        if (en) {
            for (const v of en.values) {
                const c = CompletionItem.create(v.name)
                c.kind = CompletionItemKind.EnumMember
                c.detail = enumValueDetail(v)
                c.documentation = enumValueDocs(v, en)
                c.data = en.tdk
                if (dotDel) {
                    c.insertText = ` == ${en.name} ${v.name}`
                }
                c.sortText = FIELD_SORT
                addUniqueCompletionItem(res, c)
            }
        }
        else
            console.error(`typeDeclDefinition: failed to find enum ${td.enumName} in ${td.mod}`)
    }
    if (td.alias.length > 0) {
        const td1 = cr.typeDefs.find(t => t.name === td.alias && t.mod === td.mod)
        if (td1) {
            const td2 = cr.typeDecls.find(t => t.tdk === td1.tdk)
            if (td2 && td2 != td)
                resultTd = typeDeclCompletion_(td2, cr, delimiter, Brackets.None, depth + 1, res)
            // else
            //     console.error(`typeDeclDefinition: failed to find type ${td1.tdk} in ${td.mod}`)
        }
        // else
        //     console.error(`typeDeclDefinition: failed to find type ${td.alias} in ${td.mod}`)
    }
    // if (td.baseType === BaseType.tFunction) {
    // 	const func = cr.functions.find(f => f.name === td.tdk && f.mod === td.mod)
    // 	if (func)
    // 		return func.decl
    // 	else
    // 		console.error(`typeDeclDefinition: failed to find function ${td.tdk} in ${td.mod}`)
    // }
    // pointer with empty tdk1 is void, array with empty tdk1 is unspecified array
    if ((td.baseType === BaseType.tPointer || ((td.baseType === BaseType.tArray || td.dim.length > 0) && (brackets == Brackets.Square || brackets == Brackets.QuestionSquare))) && td.tdk1.length > 0) {
        const td1 = cr.typeDecls.find(t => t.tdk === td.tdk1)
        if (td1)
            resultTd = typeDeclCompletion_(td1, cr, delimiter, Brackets.None, depth + 1, res)
        else
            console.error(`typeDeclDefinition: failed to find type ${td.tdk1}`)
    }
    // table with empty tdk2 is unspecified table
    if (td.baseType === BaseType.tTable && (brackets == Brackets.Square || brackets == Brackets.QuestionSquare) && td.dim.length == 0 && td.tdk1.length > 0) {
        const td2 = cr.typeDecls.find(t => t.tdk === td.tdk2)
        if (td2)
            resultTd = typeDeclCompletion_(td2, cr, delimiter, Brackets.None, depth + 1, res)
        else
            console.error(`typeDeclDefinition: failed to find type ${td.tdk2}`)
    }
    // return td

    if (delimiter != Delimiter.Arrow && delimiter != Delimiter.Pipe && td.dim.length == 0) {
        const isVariant = td.baseType === BaseType.tVariant
        td.fields.forEach(f => {
            const c = CompletionItem.create(f.name)
            if (isVariant) {
                if (dotDel)
                    c.insertText = ` as ${f.name}`
                else if (qDotDel)
                    c.insertText = ` ?as ${f.name}`
            }
            c.kind = CompletionItemKind.Field
            c.detail = typeDeclFieldDetail(f)
            c.documentation = typeDeclFieldDocs(f, td)
            c.data = f.tdk
            c.sortText = FIELD_SORT
            addUniqueCompletionItem(res, c)
        })
        if (td.baseType == BaseType.tFloat2 || td.baseType == BaseType.tFloat3 || td.baseType == BaseType.tFloat4
            || td.baseType == BaseType.tInt2 || td.baseType == BaseType.tInt3 || td.baseType == BaseType.tInt4 || td.baseType == BaseType.tRange
            || td.baseType == BaseType.tUInt2 || td.baseType == BaseType.tUInt3 || td.baseType == BaseType.tUInt4 || td.baseType == BaseType.tURange
        ) {
            let dim = td.baseType.endsWith('4') ? 4 : td.baseType.endsWith('3') ? 3 : 2
            let type = td.baseType.startsWith('f') ? BaseType.tFloat : td.baseType.startsWith('u') ? BaseType.tUInt : BaseType.tInt
            if (brackets != Brackets.Square && brackets != Brackets.QuestionSquare) {
                const fieldsStr = 'xyzw'
                for (let i = 0; i < dim; i++) {
                    const c = CompletionItem.create(fieldsStr.charAt(i))
                    c.kind = CompletionItemKind.Field
                    c.detail = `${c.label} : ${type}`
                    c.data = type
                    c.sortText = FIELD_SORT
                    addUniqueCompletionItem(res, c)
                }
            }
            // const td2 = cr.typeDecls.find(t => t.tdk === type)
            // if (td2)
            //     resultTd = typeDeclCompletion_(td2, cr, delimiter, Brackets.None, depth + 1, res)
        }
        else if (td.baseType == BaseType.tRange64) {
            const td2 = cr.typeDecls.find(t => t.tdk === BaseType.tInt64)
            if (td2)
                resultTd = typeDeclCompletion_(td2, cr, delimiter, Brackets.None, depth + 1, res)
        }
        else if (td.baseType == BaseType.tURange64) {
            const td2 = cr.typeDecls.find(t => t.tdk === BaseType.tUInt64)
            if (td2)
                resultTd = typeDeclCompletion_(td2, cr, delimiter, Brackets.None, depth + 1, res)
        }
    }
    if (delimiter == Delimiter.Is) {
        const td2 = cr.typeDecls.find(t => t.tdk === BaseType.tBool)
        if (td2 && td2 != td)
            resultTd = typeDeclCompletion_(td2, cr, delimiter, Brackets.None, depth + 1, res)
    }
    let searchOperatorName = brackets == Brackets.Square ? '[]' : brackets == Brackets.QuestionSquare ? '?[]' : ''
    if (searchOperatorName.length > 0) {
        for (const fn of cr.functions) {
            if (fn.args.length > 0 && fn.name == searchOperatorName && fn.args[0].tdk === td.tdk) {
                const td2 = cr.typeDecls.find(t => t.tdk === fn.tdk)
                if (td2) {
                    resultTd = typeDeclCompletion_(td2, cr, delimiter, Brackets.None, depth + 1, res)
                }
            }
        }
    } else {
        const propPrefix = PROPERTY_PREFIXES.filter(p => p[0] == delimiter)
        const propertyPrefixes = propPrefix.length > 0 ? propPrefix :
            (dotDel) ? PROPERTY_PREFIXES : []
        for (const propertyPrefix of propertyPrefixes) {
            for (const fn of cr.functions) {
                if (fn.args.length > 0 && fn.name.startsWith(propertyPrefix[1][0]) && fn.args[0].tdk === td.tdk) {
                    const propertyName = fixPropertyName(fn.name)
                    const c = CompletionItem.create(propertyName)
                    c.kind = CompletionItemKind.Property
                    c.detail = funcDetail(fn)
                    c.documentation = funcDocs(fn)
                    c.data = fn.tdk
                    c.sortText = PROPERTY_SORT
                    c.insertText = c.label
                    addUniqueCompletionItem(res, c)
                }
            }
        }
    }

    return resultTd
}


export const PROPERTY_PREFIX = '.`'

const PROPERTY_PREFIXES: [Delimiter, [string, string]][] = [
    [Delimiter.QuestionDot, ['?.`', '?.']],
    [Delimiter.QuestionDot, ['`?.`', '?.']],
    [Delimiter.As, ['`as`', ' as ']],
    [Delimiter.As, ['``as`', ' as ']],
    [Delimiter.Is, ['`is`', ' is ']],
    [Delimiter.Is, ['``is`', ' is ']],
    [Delimiter.QuestionAs, ['?as`', ' ?as ']],
    [Delimiter.QuestionAs, ['`?as`', ' ?as ']],
]

export function fixPropertyName(op: string) {
    for (const prefix of PROPERTY_PREFIXES) {
        if (op.startsWith(prefix[1][0]))
            return prefix[1][1] + op.substring(prefix[1][0].length)
    }
    return null
}

export interface CompletionTypeDef extends CompletionAt {
    name: string
    mod: string
    tdk: string
}

export function typedefDetail(t: CompletionTypeDef) {
    return `typedef ${modPrefix(t.mod)}${t.name} = ${t.tdk}`
}

export function typedefDocs(t: CompletionTypeDef) {
    return `typedef ${modPrefix(t.mod)}${t.name} = ${t.tdk}`
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
    origMod: string
    cpp: string
    tdk: string
    decl: CompletionAt
    args: CompletionFuncArg[]
    gen: boolean
    isClassMethod: boolean
    isGeneric: boolean
}

function funcRetTypeSuffix(retType: string) {
    return retType.length === 0 ? '' : ` : ${retType}`
}

export function funcDetail(f: CompletionFunction) {
    return `def ${modPrefix(f.mod)}${f.name}(${f.args.map(funcArgDetail).join('; ')})${funcRetTypeSuffix(f.tdk)}`
}

export function funcDocs(f: CompletionFunction) {
    let res = `def ${modPrefix(f.mod)}${f.name}(${f.args.map(funcArgDetail).join('; ')})${funcRetTypeSuffix(f.tdk)}`
    if (f.cpp.length > 0)
        res += `\n[${f.cpp}(...)]`
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

export interface ModDeps {
    mod: string
    depth: number
}

export interface ModuleRequirement extends CompletionAt {
    mod: string
    req: string
    file: string
    isPublic: boolean
    dependencies: ModDeps[]

    _used: boolean
    _range: Range
}

export interface ValidationResult {
    errors: DasError[]
    tokens: DasToken[]
    completion: CompletionResult
    dasRoot: string
    requirements: ModuleRequirement[]
}

export function AtToUri(at: CompletionAt, documentUri: string, settings: DasSettings, dasRoot: string, cache: Map<string, string> = null) {
    if (at.file?.length == 0)
        return ''

    if (cache && cache.has(at.file)) {
        return cache.get(at.file)
    }

    const res = AtToUri_(at, documentUri, settings, dasRoot)
    if (cache) {
        cache.set(at.file, res)
    }
    return res
}

function AtToUri_(at: CompletionAt, documentUri: string, settings: DasSettings, dasRoot: string) {
    // DON'T DO THIS
    // if (fs.existsSync(at.file)) {
    //     return URI.file(at.file).toString()
    // }

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
    // if (res.end.character > 0 && at.line === at.lineEnd)
    //     res.end.character += 1 // magic, don't ask, it works
    return res
}

export interface FixedValidationResult extends ValidationResult {
    uri: string
    fileVersion: integer
    completionItems: CompletionItem[]
    filesCache: Map<string, string>
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

export function rangeLength(range: Range) {
    return (range.end.character - range.start.character)
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

function isRangeOverlap(a: Range, b: Range) {
    return isPositionLessOrEqual(a.start, b.end) && isPositionLessOrEqual(b.start, a.end)
}

// completely empty range
export function isRangeZeroEmpty(a: Range) {
    return (a.start.line === 0 && a.start.character === 0 && a.end.line === 0 && a.end.character === 0)
}

// range with zero length
export function isRangeLengthZero(a: Range) {
    return a.start.line === a.end.line && a.end.character - a.start.character == 0
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

export function moduleTdk(tdk: string): string {
    const till = tdk.indexOf("<")
    const skip = tdk.indexOf("::")
    if (skip > 0 && (till < 0 || skip < till))
        return tdk.substring(0, skip)
    return ""
}

export function shortTdk(tdk: string): string {
    const till = tdk.indexOf("<")
    const skip = tdk.indexOf("::")
    if (skip > 0 && (till < 0 || skip < till))
        return tdk.substring(skip + 2)
    return tdk
}

export function closedBracketPos(doc: TextDocument, pos: Position): Position {
    let line = doc.getText(Range.create(pos.line, pos.character, pos.line + 50, pos.character + 500))
    let num = 0
    // skip spaces
    let i = 0
    for (; i < line.length; i++) {
        const ch = line[i]
        if (!isSpaceChar(ch))
            break
    }

    if (line[i] != '(')
        return pos

    for (; i < line.length; i++) {
        const ch = line[i]
        if (ch == '(')
            num++
        else if (ch == ')')
            num--
        if (num == 0)
            return doc.positionAt(doc.offsetAt(pos) + i + 1)
    }
    return pos
}
