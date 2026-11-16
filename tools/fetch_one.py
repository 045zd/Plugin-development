import urllib.request, ssl, sys
ctx = ssl._create_unverified_context()
def get(url, out):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"})
    for attempt in range(3):
        try:
            data = urllib.request.urlopen(req, context=ctx, timeout=40).read()
            open(out, "wb").write(data)
            print("OK", out, len(data))
            return
        except Exception as e:
            print("RETRY", attempt, e)
    print("FAIL", out)

base = "https://raw.githubusercontent.com/jackwener/opencli/main/clis/chaoxing/"
get(base + "utils.js", "opencli-utils.js")
get(base + "exams.js", "opencli-exams.js")
get(base + "auth.js", "opencli-auth.js")
