/**
 * 分隔符的可读名称与序列化。
 *
 * 分隔符本身是 "\n\n"、"。" 这样的原始字符，直接摆在界面上既看不出是什么，
 * 也难以判断优先级。这里给常用分隔符配上中文名，并保留转义形式的读写能力，
 * 让用户既能点选常用项，也能手输任意字符。
 */

export interface SeparatorOption {
    value: string
    label: string
}

/** 常用分隔符，顺序即推荐的优先级：段落 → 句子 → 标点。 */
export const COMMON_SEPARATORS: SeparatorOption[] = [
    { value: "\n\n", label: "双换行 (\\n\\n)" },
    { value: "\n", label: "单换行 (\\n)" },
    { value: "。", label: "中文句号 (。)" },
    { value: "！", label: "感叹号 (！)" },
    { value: "？", label: "问号 (？)" },
    { value: ";", label: "英文分号 (;)" },
    { value: "；", label: "中文分号 (；)" },
    { value: ". ", label: "英文句号 (. )" },
    { value: "，", label: "中文逗号 (，)" },
]

const LABEL_BY_VALUE = new Map(COMMON_SEPARATORS.map((item) => [item.value, item.label]))

/** 把原始分隔符转成界面上显示的名称；不认识的分隔符回退到转义后的字面量。 */
export function separatorLabel(value: string): string {
    return LABEL_BY_VALUE.get(value) ?? `「${escapeSeparator(value)}」`
}

/** 把不可见字符转成可读的转义写法，便于在输入框里编辑。 */
export function escapeSeparator(value: string): string {
    return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\t", "\\t").replaceAll("\r", "\\r")
}

/** escapeSeparator 的逆运算。 */
export function unescapeSeparator(value: string): string {
    return value.replaceAll("\\n", "\n").replaceAll("\\t", "\t").replaceAll("\\r", "\r").replaceAll("\\\\", "\\")
}

/** 追加一个分隔符，已存在时原样返回，避免出现重复项。 */
export function addSeparator(current: string[], raw: string): string[] {
    const value = unescapeSeparator(raw.trim())
    if (!value || current.includes(value)) return current
    return [...current, value]
}

export function removeSeparator(current: string[], value: string): string[] {
    return current.filter((item) => item !== value)
}
