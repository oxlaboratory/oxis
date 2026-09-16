-- network.lua — OXIS built-in network plugin
oxis.command("myip", function() oxis.run("(Invoke-WebRequest -Uri 'https://api.ipify.org' -UseBasicParsing).Content") end, "show this machine's public IP")
oxis.command("wifi", function() oxis.run("netsh wlan show interfaces") end, "show Wi-Fi interface details")
