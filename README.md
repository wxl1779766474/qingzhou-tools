# 轻舟工具

一个轻量、简约的在线工具集合网站。转换和报告在浏览器本地处理；Android 性能数据通过 WebUSB 从已授权设备直接读取，不上传云端。

## 功能

- 链接转二维码
- JSON 格式化、压缩、键名排序、语法高亮与放大查看
- UTF-8 Base64 编解码
- URL 与参数值编解码
- 秒/毫秒时间戳转换
- 文本字符、词、行与字节统计
- 二维码、JSON、Base64、URL 与时间戳的浏览器本地使用记录，可一键恢复输入和处理设置
- Android App 快速性能测试：无需本地助手，桌面 Chrome/Edge 通过 WebUSB 直连手机，采集 CPU、PSS 内存、HWUI 帧表现、网络区间流量、电池温度与可选热状态
- Android 性能报告保存在 IndexedDB，最近 20 份可恢复查看，并可导出 JSON 或 CSV

## Android 性能测试

1. 使用桌面版 Chrome 或 Edge，通过 HTTPS 或 localhost 打开网站。
2. 在 Android 手机开启开发者选项与 USB 调试，使用可传输数据的 USB 线连接电脑。
3. 进入“Android 性能测试”，点击“连接 Android 设备”，在浏览器选择设备并在手机 RSA 弹窗中允许调试。
4. 确认前台 App 或输入目标包名，开始测试后在手机上手动操作，完成后停止并查看报告。

无需下载助手。若 USB 接口被 Android Studio 或本机 `adb` 占用，请先释放接口；网页 WebUSB 与桌面 `adb` 不能同时占用同一台设备。完整说明见 [Android WebUSB 性能测试使用指南](docs/android-webusb-performance-usage.md)。

## 本地运行

```bash
npm run dev
```

## 验证

```bash
npm run build
npm test
```
