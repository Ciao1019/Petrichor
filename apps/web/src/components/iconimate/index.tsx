"use client"

import * as React from "react"

import { GLYPHS } from "./glyphs.generated"
import {
  createIconimateIcon,
  type IconAnimation,
  type IconComponent,
  type IconProps,
} from "./icon"

export type { Icon, IconComponent, IconProps, LucideIcon, LucideProps } from "./icon"

function icon(
  name: string,
  slug: keyof typeof GLYPHS,
  animation: IconAnimation = "tilt",
  options?: { loading?: boolean },
) {
  return createIconimateIcon(name, GLYPHS[slug], animation, options)
}

export const Activity = icon("Activity", "pulse", "pulse")
export const AlertCircle = icon("AlertCircle", "warning-circle", "shake")
export const AlertTriangle = icon("AlertTriangle", "warning", "shake")
export const AlignCenterIcon = icon("AlignCenter", "text-align-center", "draw")
export const AlignJustifyIcon = icon("AlignJustify", "text-align-justify", "draw")
export const AlignLeftIcon = icon("AlignLeft", "text-align-left", "draw")
export const AlignRightIcon = icon("AlignRight", "text-align-right", "draw")
export const AppWindowIcon = icon("AppWindow", "app-window", "fold")
export const AppleIcon = icon("Apple", "apple-logo", "bounce")
export const ArrowDown = icon("ArrowDown", "arrow-down", "slide-down")
export const ArrowDownRight = icon("ArrowDownRight", "arrow-down-right", "slide-down")
export const ArrowDownToLine = icon("ArrowDownToLine", "tray-arrow-down", "slide-down")
export const ArrowLeft = icon("ArrowLeft", "arrow-left", "slide-left")
export const ArrowRight = icon("ArrowRight", "arrow-right", "slide-right")
export const ArrowUp = icon("ArrowUp", "arrow-up", "slide-up")
export const ArrowUpRight = icon("ArrowUpRight", "arrow-up-right", "slide-up")
export const AudioLines = icon("AudioLines", "waveform", "pulse")
export const BaselineIcon = icon("Baseline", "text-a-underline", "draw")
export const Bell = icon("Bell", "bell", "swing")
export const BellRing = icon("BellRing", "bell-ringing", "swing")
export const BoldIcon = icon("Bold", "text-b", "pop")
export const Book = icon("Book", "book", "fold")
export const BookOpen = icon("BookOpen", "book-open", "fold")
export const BracesIcon = icon("Braces", "brackets-curly", "pop")
export const Brain = icon("Brain", "brain", "pulse")
export const BrainCircuit = icon("BrainCircuit", "circuitry", "pulse")
export const Calendar = icon("Calendar", "calendar", "pop")
export const Check = icon("Check", "check", "pop")
export const CheckCheck = icon("CheckCheck", "checks", "pop")
export const CheckCircle2 = icon("CheckCircle", "check-circle", "pop")
export const ChevronDown = icon("ChevronDown", "caret-down", "slide-down")
export const ChevronFirst = icon("ChevronFirst", "caret-line-left", "slide-left")
export const ChevronLast = icon("ChevronLast", "caret-line-right", "slide-right")
export const ChevronLeft = icon("ChevronLeft", "caret-left", "slide-left")
export const ChevronRight = icon("ChevronRight", "caret-right", "slide-right")
export const ChevronUp = icon("ChevronUp", "caret-up", "slide-up")
export const ChevronsUpDownIcon = icon("ChevronsUpDown", "caret-up-down", "bounce")
export const Circle = icon("Circle", "circle", "pulse")
export const CircleAlert = AlertCircle
export const CircleDot = icon("CircleDot", "record", "pulse")
export const Clock = icon("Clock", "clock", "swing")
export const Code2 = icon("Code", "code", "draw")
export const Columns3Icon = icon("Columns", "columns", "fold")
export const Combine = icon("Combine", "circles-three-plus", "pop")
export const Compass = icon("Compass", "compass", "spin")
export const Copy = icon("Copy", "copy", "pop")
export const CornerDownLeftIcon = icon("CornerDownLeft", "arrow-elbow-down-left", "slide-down")
export const Database = icon("Database", "database", "bounce")
export const DotIcon = icon("Dot", "dot", "pulse")
export const Download = icon("Download", "download-simple", "slide-down")
export const EraserIcon = icon("Eraser", "eraser", "shake")
export const ExternalLink = icon("ExternalLink", "arrow-square-out", "slide-right")
export const Eye = icon("Eye", "eye", "pulse")
export const EyeOff = icon("EyeOff", "eye-slash", "shake")
export const File = icon("File", "file", "fold")
export const FileCode = icon("FileCode", "file-code", "fold")
export const FileDigit = icon("FileDigit", "file-text", "fold")
export const FileDown = icon("FileDown", "file-arrow-down", "slide-down")
export const FilePlus2 = icon("FilePlus", "file-plus", "pop")
export const FileStack = icon("FileStack", "files", "fold")
export const FileText = icon("FileText", "file-text", "fold")
export const FileUp = icon("FileUp", "file-arrow-up", "slide-up")
export const Film = icon("Film", "film-strip", "fold")
export const FlagIcon = icon("Flag", "flag", "swing")
export const Flame = icon("Flame", "fire", "swing")
export const FlaskConical = icon("Flask", "flask", "swing")
export const Folder = icon("Folder", "folder", "fold")
export const FolderInput = icon("FolderInput", "folder-open", "slide-right")
export const FolderOpen = icon("FolderOpen", "folder-open", "fold")
export const FolderPlus = icon("FolderPlus", "folder-plus", "pop")
export const GalleryHorizontalEnd = icon("Gallery", "images", "slide-right")
export const Gauge = icon("Gauge", "gauge", "swing")
export const GitForkIcon = icon("GitFork", "git-fork", "draw")
export const GitPullRequestArrow = icon("GitPullRequest", "git-pull-request", "draw")
export const Github = icon("Github", "github-logo", "bounce")
export const Globe = icon("Globe", "globe", "spin")
export const Globe2 = Globe
export const Grid2X2Icon = icon("Grid2X2", "grid-four", "pop")
export const Grid3x3Icon = icon("Grid3X3", "grid-nine", "pop")
export const GripHorizontal = icon("GripHorizontal", "dots-six", "shake")
export const GripVertical = icon("GripVertical", "dots-six-vertical", "shake")
export const Hash = icon("Hash", "hash", "pop")
export const Heading1Icon = icon("Heading1", "text-h-one", "draw")
export const Heading2Icon = icon("Heading2", "text-h-two", "draw")
export const Heading3Icon = icon("Heading3", "text-h-three", "draw")
export const Heading4Icon = icon("Heading4", "text-h-four", "draw")
export const Heading5Icon = icon("Heading5", "text-h-five", "draw")
export const Heading6Icon = icon("Heading6", "text-h-six", "draw")
export const HighlighterIcon = icon("Highlighter", "highlighter", "draw")
export const History = icon("History", "clock-counter-clockwise", "spin")
export const HomeIcon = icon("Home", "house", "bounce")
export const ImageIcon = icon("Image", "image", "fold")
export const Inbox = icon("Inbox", "tray", "bounce")
export const IndentIcon = icon("Indent", "text-indent", "slide-right")
export const Info = icon("Info", "info", "pop")
export const ItalicIcon = icon("Italic", "text-italic", "draw")
export const KeyboardIcon = icon("Keyboard", "keyboard", "bounce")
export const KeyRound = icon("Key", "key", "swing")
export const Languages = icon("Languages", "translate", "draw")
export const Laptop = icon("Laptop", "laptop", "fold")
export const LeafIcon = icon("Leaf", "leaf", "swing")
export const Library = icon("Library", "books", "fold")
export const LightbulbIcon = icon("Lightbulb", "lightbulb", "pop")
export const Link = icon("Link", "link", "shake")
export const Link2 = Link
export const Link2Off = icon("LinkOff", "link-break", "shake")
export const List = icon("List", "list", "draw")
export const ListChecks = icon("ListChecks", "list-checks", "draw")
export const ListCollapseIcon = icon("ListCollapse", "list-dashes", "fold")
export const ListOrdered = icon("ListOrdered", "list-numbers", "draw")
export const ListTodo = ListChecks
export const ListTree = icon("ListTree", "tree-structure", "draw")
export const Loader2 = icon("Loader", "spinner-gap", "spin", { loading: true })
export const Lock = icon("Lock", "lock", "bounce")
export const LockKeyhole = icon("LockKeyhole", "lock-key", "bounce")
export const LockOpen = icon("LockOpen", "lock-open", "bounce")
export const LogIn = icon("LogIn", "sign-in", "slide-right")
export const LogOut = icon("LogOut", "sign-out", "slide-right")
export const MapPin = icon("MapPin", "map-pin", "bounce")
export const Maximize = icon("Maximize", "corners-out", "pop")
export const Merge = icon("Merge", "git-merge", "draw")
export const MessageCircle = icon("MessageCircle", "chat-circle", "pop")
export const MessageCircleQuestion = icon("MessageCircleQuestion", "chat-circle-dots", "pop")
export const MessageSquarePlus = icon("MessageSquarePlus", "chat-centered-dots", "pop")
export const MessageSquareTextIcon = icon("MessageSquareText", "chat-text", "pop")
export const MessagesSquareIcon = icon("MessagesSquare", "chats", "pop")
export const Milestone = icon("Milestone", "signpost", "swing")
export const Minus = icon("Minus", "minus", "pop")
export const Monitor = icon("Monitor", "monitor", "fold")
export const MoreHorizontal = icon("MoreHorizontal", "dots-three", "pulse")
export const MusicIcon = icon("Music", "music-note", "bounce")
export const Network = icon("Network", "graph", "draw")
export const Newspaper = icon("Newspaper", "newspaper", "fold")
export const OctagonXIcon = icon("OctagonX", "warning-octagon", "shake")
export const OutdentIcon = icon("Outdent", "text-outdent", "slide-left")
export const Package = icon("Package", "package", "bounce")
export const PaintBucketIcon = icon("PaintBucket", "paint-bucket", "swing")
export const PanelLeftClose = icon("PanelLeftClose", "sidebar-simple", "slide-left")
export const PanelLeftOpen = icon("PanelLeftOpen", "sidebar-simple", "slide-right")
export const PanelRight = icon("PanelRight", "sidebar", "slide-right")
export const PenIcon = icon("Pen", "pen", "draw")
export const PenToolIcon = icon("PenTool", "pen-nib", "draw")
export const Pencil = icon("Pencil", "pencil-simple", "draw")
export const PencilLine = icon("PencilLine", "pencil-line", "draw")
export const PilcrowIcon = icon("Pilcrow", "paragraph", "draw")
export const Plug = icon("Plug", "plug", "bounce")
export const Plus = icon("Plus", "plus", "pop")
export const Quote = icon("Quote", "quotes", "pop")
export const RadicalIcon = icon("Radical", "math-operations", "draw")
export const Redo2Icon = icon("Redo", "arrow-clockwise", "spin")
export const RefreshCcw = icon("RefreshCcw", "arrows-counter-clockwise", "spin")
export const RefreshCw = icon("RefreshCw", "arrows-clockwise", "spin")
export const Replace = icon("Replace", "arrows-left-right", "shake")
export const Rocket = icon("Rocket", "rocket", "slide-up")
export const RotateCcw = icon("RotateCcw", "arrow-counter-clockwise", "spin")
export const Save = icon("Save", "floppy-disk", "bounce")
export const ScaleIcon = icon("Scale", "scales", "swing")
export const ScanSearch = icon("ScanSearch", "scan", "scan")
export const Search = icon("Search", "magnifying-glass", "scan")
export const Send = icon("Send", "paper-plane-tilt", "slide-right")
export const Server = icon("Server", "hard-drives", "bounce")
export const Settings2 = icon("Settings", "sliders-horizontal", "slide-right")
export const Share2 = icon("Share", "share-network", "pop")
export const ShieldAlert = icon("ShieldAlert", "shield-warning", "shake")
export const ShieldCheck = icon("ShieldCheck", "shield-check", "pop")
export const ShieldOff = icon("ShieldOff", "shield-slash", "shake")
export const Shuffle = icon("Shuffle", "shuffle", "shake")
export const Smartphone = icon("Smartphone", "device-mobile", "bounce")
export const SmileIcon = icon("Smile", "smiley", "pop")
export const Sparkles = icon("Sparkles", "sparkle", "sparkle")
export const Square = icon("Square", "square", "pop")
export const SquareArrowOutUpRightIcon = ExternalLink
export const SquareSplitHorizontalIcon = icon("SquareSplitHorizontal", "square-split-horizontal", "fold")
export const StarIcon = icon("Star", "star", "sparkle")
export const StrikethroughIcon = icon("Strikethrough", "text-strikethrough", "draw")
export const SubscriptIcon = icon("Subscript", "text-subscript", "draw")
export const SuperscriptIcon = icon("Superscript", "text-superscript", "draw")
export const Table = icon("Table", "table", "fold")
export const TableOfContentsIcon = icon("TableOfContents", "list-dashes", "draw")
export const Tags = icon("Tags", "tag", "swing")
export const Text = icon("Text", "text-t", "draw")
export const ThumbsDown = icon("ThumbsDown", "thumbs-down", "bounce")
export const ThumbsUp = icon("ThumbsUp", "thumbs-up", "bounce")
export const Timer = icon("Timer", "timer", "swing")
export const Trash2 = icon("Trash", "trash", "shake")
export const TriangleAlert = AlertTriangle
export const TwitterIcon = icon("Twitter", "twitter-logo", "bounce")
export const UnderlineIcon = icon("Underline", "text-underline", "draw")
export const Undo2 = icon("Undo", "arrow-counter-clockwise", "spin")
export const Ungroup = icon("Ungroup", "bounding-box", "shake")
export const Unlink = Link2Off
export const Upload = icon("Upload", "upload-simple", "slide-up")
export const UploadCloud = icon("UploadCloud", "cloud-arrow-up", "slide-up")
export const UserCog = icon("UserCog", "user-gear", "spin")
export const Wand2 = icon("Wand", "magic-wand", "sparkle")
export const WrapText = icon("WrapText", "text-align-left", "draw")
export const Wrench = icon("Wrench", "wrench", "swing")
export const X = icon("X", "x", "pop")
export const XCircle = icon("XCircle", "x-circle", "pop")
export const Zap = icon("Zap", "lightning", "sparkle")

// Lucide 的 `Icon` 后缀别名。
export const AlertCircleIcon = AlertCircle
export const ArrowDownIcon = ArrowDown
export const ArrowDownToLineIcon = ArrowDownToLine
export const ArrowUpIcon = ArrowUp
export const AudioLinesIcon = AudioLines
export const BrainIcon = Brain
export const CalendarIcon = Calendar
export const CheckIcon = Check
export const ChevronDownIcon = ChevronDown
export const ChevronLeftIcon = ChevronLeft
export const ChevronRightIcon = ChevronRight
export const ChevronUpIcon = ChevronUp
export const CircleCheckIcon = CheckCircle2
export const CircleIcon = Circle
export const Clock3 = Clock
export const ClockIcon = Clock
export const Code2Icon = Code2
export const CombineIcon = Combine
export const CompassIcon = Compass
export const CopyIcon = Copy
export const DownloadIcon = Download
export const ExternalLinkIcon = ExternalLink
export const EyeIcon = Eye
export const FileCode2 = FileCode
export const FileCodeIcon = FileCode
export const FileIcon = File
export const FileUpIcon = FileUp
export const FilmIcon = Film
export const GithubIcon = Github
export const InfoIcon = Info
export const Link2Icon = Link2
export const LinkIcon = Link
export const ListIcon = List
export const ListOrderedIcon = ListOrdered
export const Loader2Icon = Loader2
export const LoaderIcon = Loader2
export const Maximize2 = Maximize
export const MinusIcon = Minus
export const MoreHorizontalIcon = MoreHorizontal
export const PanelLeftCloseIcon = PanelLeftClose
export const PanelLeftIcon = PanelLeftOpen
export const PencilIcon = Pencil
export const PencilLineIcon = PencilLine
export const PlusIcon = Plus
export const QuoteIcon = Quote
export const RefreshCwIcon = RefreshCw
export const SearchIcon = Search
export const SquareIcon = Square
export const TableIcon = Table
export const Trash2Icon = Trash2
export const TrashIcon = Trash2
export const TriangleAlertIcon = TriangleAlert
export const Undo2Icon = Undo2
export const XCircleIcon = XCircle
export const XIcon = X

// Tabler 兼容别名；迁移后调用方不再依赖 Tabler 类型或运行时。
export const IconBook = Book
export const IconBookmarks = icon("Bookmarks", "bookmarks", "fold")
export const IconChartBar = icon("ChartBar", "chart-bar", "bounce")
export const IconChevronDown = ChevronDown
export const IconChevronRight = ChevronRight
export const IconCircleCheckFilled = CheckCircle2
export const IconCirclePlusFilled = icon("CirclePlus", "plus-circle", "pop")
export const IconDots = MoreHorizontal
export const IconDotsVertical = icon("DotsVertical", "dots-three-vertical", "pulse")
export const IconFileImport = FileDown
export const IconFiles = FileStack
export const IconFolder = Folder
export const IconFolders = icon("Folders", "folders", "fold")
export const IconGripVertical = GripVertical
export const IconHistory = History
export const IconKey = KeyRound
export const IconLayoutColumns = Columns3Icon
export const IconListDetails = icon("ListDetails", "list-dashes", "draw")
export const IconLoader = Loader2
export const IconLogout = LogOut
export const IconNetwork = Network
export const IconNotification = Bell
export const IconPackage = Package
export const IconPalette = icon("Palette", "palette", "swing")
export const IconPlugConnected = icon("PlugConnected", "plug-charging", "bounce")
export const IconPlus = Plus
export const IconRobot = icon("Robot", "robot", "bounce")
export const IconSettings = icon("Gear", "gear", "spin")
export const IconShare3 = Share2
export const IconSparkles = Sparkles
export const IconTrash = Trash2
export const IconTrendingDown = icon("TrendDown", "trend-down", "slide-down")
export const IconTrendingUp = icon("TrendUp", "trend-up", "slide-up")
export const IconUserCircle = icon("UserCircle", "user-circle", "pop")
export const IconUsers = icon("Users", "users", "pop")

// Hugeicons 兼容数据别名。HugeiconsIcon 会把这些本地图标组件直接渲染出来。
export const AlignBoxBottomCenterIcon = icon("AlignBottom", "align-bottom", "slide-down")
export const ArrowDown01Icon = ArrowDown
export const ArrowLeft01Icon = ArrowLeft
export const ArrowRight01Icon = ArrowRight
export const ArrowUp01Icon = ArrowUp
export const ArrowUpDownIcon = icon("ArrowUpDown", "arrows-down-up", "shake")
export const Calendar03Icon = Calendar
export const Cancel01Icon = X
export const Comment01Icon = MessageSquareTextIcon
export const Download01Icon = Download
export const File01Icon = File
export const FileDiffIcon = icon("FileDiff", "git-diff", "fold")
export const FileImageIcon = icon("FileImage", "file-image", "fold")
export const FileSpreadsheetIcon = icon("FileSpreadsheet", "file-xls", "fold")
export const FileUploadIcon = FileUp
export const FilterIcon = icon("Filter", "funnel", "fold")
export const GalleryThumbnailsIcon = icon("GalleryThumbnails", "images", "fold")
export const GridViewIcon = Grid2X2Icon
export const Heading01Icon = Heading1Icon
export const ImageCompositionIcon = icon("ImageComposition", "image-square", "fold")
export const LayoutThreeColumnIcon = Columns3Icon
export const LeftToRightListBulletIcon = icon("ListBullet", "list-bullets", "draw")
export const Loading03Icon = Loader2
export const MinusSignCircleIcon = icon("MinusCircle", "minus-circle", "pop")
export const Moon02Icon = icon("Moon", "moon", "swing")
export const ParagraphIcon = PilcrowIcon
export const PlusSignCircleIcon = IconCirclePlusFilled
export const RotateClockwiseIcon = Redo2Icon
export const Search01Icon = Search
export const SidebarLeftIcon = PanelLeftOpen
export const Table01Icon = Table
export const TextCenterlineCenterTopIcon = AlignCenterIcon
export const TextNumberSignIcon = Hash
export const Tick02Icon = Check
export const Upload01Icon = Upload

export function HugeiconsIcon({
  icon: Component,
  ...props
}: IconProps & { icon: IconComponent }): React.ReactElement {
  return <Component {...props} />
}

/** Tool UI 的动态图标名解析只需要覆盖本项目允许使用的语义集合。 */
export const icons = {
  Activity,
  AlertCircle,
  AlertTriangle,
  Bell,
  Book,
  BookOpen,
  Calendar,
  Check,
  CheckCircle: CheckCircle2,
  Circle,
  Clock,
  Copy,
  Database,
  Download,
  ExternalLink,
  Eye,
  File,
  FileCode,
  FileText,
  Folder,
  FolderOpen,
  Globe,
  Info,
  Key: KeyRound,
  Link,
  Lock,
  Package,
  Pencil,
  Plus,
  Search,
  Settings: IconSettings,
  Share: Share2,
  ShieldCheck,
  Sparkles,
  Trash: Trash2,
  Upload,
  UserCog,
  Warning: AlertTriangle,
  Wrench,
  X,
} satisfies Record<string, IconComponent>
