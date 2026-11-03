# Activate only the paired Flow project's enabled Start generation button using
# Windows accessibility. No coordinates, global keystrokes, or security bypass.
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName WindowsBase
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FrameFlowWindow {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
  $expected = [Uri]$env:FRAME_FLOW_PROJECT_URL
  if ($expected.Scheme -ne 'https' -or $expected.Host -notin @('flow.google.com','labs.google') -or $expected.AbsolutePath -notmatch '/project/[a-zA-Z0-9_-]+$') { throw 'Invalid selected Flow project.' }
  if ([string]::IsNullOrWhiteSpace($env:FRAME_FLOW_WINDOW_TITLE)) { throw 'The paired Chrome window title is missing.' }
  $windowCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Chrome_WidgetWin_1')
  $windows = @([System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $windowCondition) | Where-Object { $_.Current.Name -eq ($env:FRAME_FLOW_WINDOW_TITLE + ' - Google Chrome') })
  if ($windows.Count -ne 1) { throw 'The paired Chrome window is not uniquely available. Keep its Flow tab selected.' }
  $handle = [IntPtr]$windows[0].Current.NativeWindowHandle
  [uint32]$chromeProcessId = 0
  [void][FrameFlowWindow]::GetWindowThreadProcessId($handle, [ref]$chromeProcessId)
  if ((Get-Process -Id $chromeProcessId).ProcessName -ne 'chrome') { throw 'The paired window is not Chrome. Nothing was activated.' }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  $scope = [System.Windows.Automation.TreeScope]::Descendants
  $addressCondition = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)),
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Address and search bar')))
  $addresses = $root.FindAll($scope, $addressCondition)
  if ($addresses.Count -ne 1) { throw 'Chrome address bar could not be uniquely verified. Nothing was activated.' }
  $address = $addresses[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
  if ($address -notmatch '^https://') { $address = 'https://' + $address }
  if (([Uri]$address).AbsoluteUri.TrimEnd('/') -cne $expected.AbsoluteUri.TrimEnd('/')) { throw 'Chrome is not displaying the paired Flow project. Nothing was activated.' }
  $buttonCondition = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)),
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Start generation')))
  $buttons = @($root.FindAll($scope, $buttonCondition) | Where-Object { $_.Current.IsEnabled -and -not $_.Current.IsOffscreen })
  if ($buttons.Count -ne 1) { throw 'The enabled Start generation button is not uniquely visible in Chrome. Nothing was activated.' }
  $pattern = $buttons[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  # InvokePattern is scoped to this verified element, with no global mouse or
  # keyboard input. Recheck the selected tab immediately before activation.
  $currentAddress = $addresses[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
  if ($currentAddress -notmatch '^https://') { $currentAddress = 'https://' + $currentAddress }
  if (([Uri]$currentAddress).AbsoluteUri.TrimEnd('/') -cne $expected.AbsoluteUri.TrimEnd('/')) { throw 'The selected Chrome tab changed. Nothing was activated.' }
  $pattern.Invoke()
  Write-Output '{"activated":true}'
} catch {
  Write-Output (@{ error = $_.Exception.Message } | ConvertTo-Json -Compress)
  exit 1
}
