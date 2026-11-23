-- The Tokyo Night (night) colour scheme of the Omarchy image: plain highlight
-- groups, no plugins.

vim.cmd("highlight clear")
if vim.fn.exists("syntax_on") == 1 then vim.cmd("syntax reset") end
vim.g.colors_name = "omarchy"
vim.o.termguicolors = true
vim.o.background = "dark"

local c = {
	bg = "#1a1b26",
	bg_dark = "#16161e",
	bg_hl = "#292e42",
	sel = "#283457",
	border = "#3b4261",
	fg = "#c0caf5",
	fg_dim = "#a9b1d6",
	comment = "#565f89",
	blue = "#7aa2f7",
	cyan = "#7dcfff",
	purple = "#bb9af7",
	orange = "#ff9e64",
	yellow = "#e0af68",
	green = "#9ece6a",
	teal = "#1abc9c",
	red = "#f7768e",
}

local function hl(group, spec) vim.api.nvim_set_hl(0, group, spec) end

hl("Normal", { fg = c.fg, bg = c.bg })
hl("NormalFloat", { fg = c.fg, bg = c.bg_dark })
hl("FloatBorder", { fg = c.blue, bg = c.bg_dark })
hl("Visual", { bg = c.sel })
hl("Search", { fg = c.bg, bg = c.yellow })
hl("IncSearch", { fg = c.bg, bg = c.orange })
hl("CurSearch", { link = "IncSearch" })
hl("LineNr", { fg = c.border })
hl("CursorLine", { bg = c.bg_hl })
hl("CursorLineNr", { fg = c.yellow, bold = true })
hl("SignColumn", { bg = c.bg })
hl("EndOfBuffer", { fg = c.bg })
hl("WinSeparator", { fg = c.border })
hl("StatusLine", { fg = c.fg_dim, bg = c.bg_hl })
hl("StatusLineNC", { fg = c.comment, bg = c.bg_dark })
hl("Pmenu", { fg = c.fg, bg = c.bg_dark })
hl("PmenuSel", { fg = c.fg, bg = c.sel })
hl("Folded", { fg = c.comment, bg = c.bg_hl })
hl("MatchParen", { fg = c.cyan, bold = true })
hl("NonText", { fg = c.border })
hl("Directory", { fg = c.blue })
hl("Title", { fg = c.blue, bold = true })
hl("ModeMsg", { fg = c.green, bold = true })
hl("MoreMsg", { fg = c.green })
hl("Question", { fg = c.green })
hl("WarningMsg", { fg = c.yellow })
hl("ErrorMsg", { fg = c.red, bold = true })
hl("Error", { fg = c.red })
hl("Todo", { fg = c.bg, bg = c.yellow, bold = true })
hl("Comment", { fg = c.comment, italic = true })
hl("Constant", { fg = c.orange })
hl("String", { fg = c.green })
hl("Character", { fg = c.green })
hl("Number", { fg = c.orange })
hl("Boolean", { fg = c.orange })
hl("Identifier", { fg = c.fg })
hl("Function", { fg = c.blue })
hl("Statement", { fg = c.purple })
hl("Conditional", { fg = c.purple })
hl("Repeat", { fg = c.purple })
hl("Keyword", { fg = c.purple })
hl("Operator", { fg = c.cyan })
hl("PreProc", { fg = c.cyan })
hl("Type", { fg = c.cyan })
hl("Special", { fg = c.teal })
hl("DiffAdd", { bg = "#243a2f" })
hl("DiffChange", { bg = "#2a2f45" })
hl("DiffDelete", { fg = c.red, bg = "#3a2230" })
hl("DiffText", { bg = "#3d59a1" })
hl("@variable", { fg = c.fg })
hl("@keyword", { link = "Keyword" })
hl("@string", { link = "String" })
hl("@comment", { link = "Comment" })
hl("@function", { link = "Function" })
hl("@type", { link = "Type" })
hl("@number", { link = "Number" })
hl("@property", { fg = c.cyan })
