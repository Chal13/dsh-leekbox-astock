# 把源码目录发布到 DSH 插件安装目录。
#
# 背景：源码（本仓库）与 DSH 实际加载的安装目录是**两份分开的拷贝**。
# 日常开发在本仓库进行；验证通过后再用这个脚本同步到安装目录，然后重启 DSH。
#
# 用法（在仓库根目录或任意位置）：
#   pwsh -File scripts\install-to-dsh.ps1                 # 同步到默认安装目录
#   pwsh -File scripts\install-to-dsh.ps1 -RunTests       # 先跑测试再同步
#   pwsh -File scripts\install-to-dsh.ps1 -Target D:\somewhere\else
#
# 注意：
# - 使用 robocopy /MIR，安装目录里多出来的文件会被删除（安装目录应只放构建产物，不要手写东西）。
# - 不同步 .git 与 node_modules（运行时不需要；要构建请在本仓库跑 node build.mjs）。
# - 宿主插件不热重载：同步完成后必须**完全退出并重开 DSH** 才生效。

param(
	[string]$Target = "D:\DSH\Projects\leekbox-astock",
	[switch]$RunTests
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path (Join-Path $root "package.json"))) {
	throw "找不到仓库根目录（package.json）：$root"
}

if ($RunTests) {
	Write-Host "==> 运行测试：node run-tests.mjs"
	Push-Location $root
	try {
		& node run-tests.mjs
		if ($LASTEXITCODE -ne 0) {
			# run-tests 在存在 known failure 时也返回 1；这里按输出判断真实失败更稳妥。
			Write-Warning "run-tests 退出码 $LASTEXITCODE（known failure 也会返回 1，请核对上面的 summary）"
		}
	} finally {
		Pop-Location
	}
}

# 客户端产物必须存在且是最新构建（改了 src/client 却忘了 build 会被 client-bundle-test 拦下）。
$client = Join-Path $root "lib\client.js"
if (-not (Test-Path $client)) {
	throw "缺少 lib/client.js：请先运行 node build.mjs"
}

New-Item -ItemType Directory -Path $Target -Force | Out-Null

Write-Host "==> 同步 $root -> $Target"
$args = @(
	$root, $Target,
	"/MIR",
	"/XD", ".git", "node_modules",
	"/NFL", "/NDL", "/NJH", "/NJS", "/NP"
)
& robocopy @args
$code = $LASTEXITCODE
if ($code -ge 8) {
	throw "robocopy 失败（退出码 $code）"
}

Write-Host ""
Write-Host "已同步到：$Target"
Write-Host "下一步：完全退出 DeepSeek Harness 再重新打开，插件才会加载新代码。"
Write-Host "（只刷新页面不够：宿主插件不热重载。）"
