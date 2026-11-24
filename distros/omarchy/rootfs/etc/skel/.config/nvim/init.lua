-- ~/.config/nvim/init.lua of the Omarchy image: Neovim with no plugins and no
-- network. Space is the leader key; `omarchy keys` lists the maps.

vim.g.mapleader = " "
vim.g.maplocalleader = " "

local opt = vim.opt
opt.number = true
opt.relativenumber = true
opt.cursorline = true
opt.signcolumn = "yes"
opt.termguicolors = true
opt.scrolloff = 6
opt.wrap = false
opt.expandtab = true
opt.shiftwidth = 2
opt.tabstop = 2
opt.smartindent = true
opt.ignorecase = true
opt.smartcase = true
opt.undofile = true
opt.splitright = true
opt.splitbelow = true
opt.clipboard = "unnamedplus"
opt.mouse = "a"
opt.updatetime = 250
opt.confirm = true
opt.wildmode = "longest:full,full"
opt.path:append("**")

vim.cmd.colorscheme("omarchy")

local map = vim.keymap.set
map("n", "<leader>w", "<cmd>write<cr>", { desc = "Save" })
map("n", "<leader>q", "<cmd>quit<cr>", { desc = "Quit" })
map("n", "<leader>ff", ":find ", { desc = "Find file" })
map("n", "<leader>fb", ":ls<cr>:buffer ", { desc = "Buffers" })
map("n", "<leader>e", "<cmd>Lexplore<cr>", { desc = "Files" })
map("n", "<Esc>", "<cmd>nohlsearch<cr>")
map("n", "<C-h>", "<C-w>h")
map("n", "<C-j>", "<C-w>j")
map("n", "<C-k>", "<C-w>k")
map("n", "<C-l>", "<C-w>l")
map("v", "<", "<gv")
map("v", ">", ">gv")

vim.api.nvim_create_autocmd("TextYankPost", {
	callback = function() vim.highlight.on_yank({ timeout = 150 }) end,
})
