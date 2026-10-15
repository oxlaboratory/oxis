"""Turns the failed tests in test.log into GitHub annotations, so a
failure can be read on the run page without opening the log."""
import re

text = open("test.log", encoding="utf-8", errors="replace").read()
blocks = re.findall(r"---- .*? stdout ----\n.*?(?=\n---- |\nfailures:\n|\Z)", text, re.S)
for block in blocks or [text[-3000:]]:
    print("::error::" + block[:3500].replace("%", "%25").replace("\r", "").replace("\n", "%0A"))
