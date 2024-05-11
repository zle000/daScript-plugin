import { CompletionItem, CompletionItemKind, Position, Range, integer } from 'vscode-languageserver/node'
import { DasSettings } from './dasSettings'
import fs = require('fs')
import path = require('path')
import { URI } from 'vscode-uri'


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

export interface CompletionAt {
    file: string
    line: integer
    column: integer
    lineEnd: integer
    columnEnd: integer

    _range: Range
    _uri: string
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
export
    function typeDeclDetail(td: CompletionTypeDecl) {
    return td.tdk
}

export function typeDeclDefinition(td: CompletionTypeDecl, cr: CompletionResult): CompletionAt {
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

export function primitiveBaseType(td: CompletionTypeDecl, cr: CompletionResult): boolean {
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
export function typeDeclDocs(td: CompletionTypeDecl, cr: CompletionResult): string {
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


export function typeDeclCompletion(td: CompletionTypeDecl, cr: CompletionResult, res: CompletionItem[]): void {
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
}

export function funcRetTypeSuffix(retType: string) {
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
    typeDefs: CompletionTypeDef[]
    globals: CompletionGlobal[]
    functions: CompletionFunction[]
}

export interface ValidationResult {
    errors: DasError[]
    tokens: DasToken[]
    completion: CompletionResult
}

export function AtToUri(at: CompletionAt, documentUri: string, settings: DasSettings) {
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

export function rangeCenter(range: Range) : Position {
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