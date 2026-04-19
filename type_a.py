import subprocess
import time

while True:
    subprocess.run(["osascript", "-e", 'tell application "System Events" to keystroke "a"'])
    time.sleep(1)
