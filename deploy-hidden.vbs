' Запускает deploy.ps1 полностью скрыто (окно PowerShell не мелькает).
' Планировщик задач вызывает: wscript.exe C:\octo-main\deploy-hidden.vbs
CreateObject("WScript.Shell").Run "powershell -NoProfile -ExecutionPolicy Bypass -File ""C:\octo-main\deploy.ps1""", 0, False
