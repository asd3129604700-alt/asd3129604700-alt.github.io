# 英文资料图片翻译工具

基于 [DonutShinobu/ShinobuTranslator](https://github.com/DonutShinobu/ShinobuTranslator) 的英文资料网页版分支。支持图片/PDF、英文小字补识别、中文贴字、框选补翻、浏览器本地翻译与 API 翻译。

## 网页使用

部署完成后，访问本仓库 GitHub Pages 地址。推荐桌面 Chrome / Edge。

1. 首次打开会自动刷新一次，以初始化浏览器本地 OCR 的运行环境。
2. 在“翻译设置 → 模型资产”打开[上游 models-v0.8.3 下载页](https://github.com/DonutShinobu/ShinobuTranslator/releases/tag/models-v0.8.3)，下载以下 5 个文件：`detector.ort`、`aot_inpaint_512.onnx`、`bubble.onnx`、`PP-OCRv6_medium_rec.onnx`、`paddleocr_v6_dict.txt`。
3. 点击“导入模型文件”，同时选择这 5 个文件。共约 196 MiB，导入时校验大小与 SHA-256，之后保存在此浏览器，无需每次导入。
4. 添加图片/PDF，选择翻译方式并开始处理。

- **浏览器本地**：首次准备浏览器语言包；无需 API Key，失败时不调用翻译 API。
- **自动**：短句优先本地；多行、长句或本地不可用时调用配置的 API。
- **API 翻译**：由使用者配置自己的服务商和 API Key。

图片识别、去字、贴字在浏览器执行。API 模式会把识别出的文字发给所选服务商。OCR 和机器翻译可能出错，尤其是色号、专名及复杂技术要求。

## 本地开发

需要 Node.js 24。

```sh
npm ci
npm run models:download -- models-v0.8.3
npm run build:web
node serve-local.cjs 8774
```

打开 `http://127.0.0.1:8774/`。修改源码后需重新构建。

## GitHub Pages 部署

使用 `<账号>.github.io` 名称的公开仓库，保持网站在域名根目录。在 Settings → Pages 中将发布来源设为 **GitHub Actions**，推送到 `main` 后执行 `Publish English Document Translator` 工作流。

此构建不上传模型权重，不依赖 Cloudflare、后端服务器或仓库 API Key。模型由使用者直接从上游下载并导入。上游扩展商店和 Cloudflare 的工作流仅在上游仓库运行。

## 许可与来源

应用沿用 GPL-3.0；保留 [LICENSE](LICENSE)、[第三方声明](THIRD_PARTY_NOTICES.md) 与[上游说明](README.upstream.md)。本分支修改了英文长行/小字识别、重复区域去重、补翻、浏览器本地翻译，以及 GitHub Pages 启动和模型导入。

模型各自的来源和发布状态见 `packages/model-manifest/publication-policy.json`。本仓库不重新托管尚未完成来源材料审核的模型，也不把本地使用能力等同于模型再分发授权。
