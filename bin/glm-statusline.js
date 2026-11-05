#!/usr/bin/env node
// 启用严格模式：变量必须声明、静默错误转为显式抛错，尽早暴露问题
'use strict';

// 入口 shim：真正的状态栏逻辑全部在仓库根目录的单文件核心 glm-statusline.js 里，
// 这里只负责加载它（require 会执行该文件的顶层代码，其中包含读取 stdin 并渲染）。
// 保持本文件极薄的原因：statusLine.command / 启动器指向的是这个稳定路径，
// 核心逻辑升级时不需要改动任何调用方配置。
require('../glm-statusline.js');
