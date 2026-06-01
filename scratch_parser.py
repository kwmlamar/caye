import re
import os

source_file = "/Users/kwmlamar/Documents/TropiTech Solutions/Sandbox/TropiChat/TropiChat Landing.html"
css_file = "/Users/kwmlamar/Documents/TropiTech Solutions/Products/TropiChat/app/landing.module.css"
jsx_file = "/Users/kwmlamar/Documents/TropiTech Solutions/Products/TropiChat/app/page.tsx"

with open(source_file, 'r', encoding='utf-8') as f:
    content = f.read()

# Extract styles
style_blocks = re.findall(r'<style>(.*?)</style>', content, re.DOTALL)
css_content = "\n".join(style_blocks)

# Scope CSS under .landing
# Simple parser: find block rules
def prefix_css(css):
    out = []
    lines = css.split('\n')
    for line in lines:
        # Ignore empty or comment lines temporarily, or handle line by line
        # A robust regex to prefix selectors:
        pass
    
    # Let's do block level regex
    # Find selector { ... }
    # To handle media queries, we should be careful.
    return css

# Actually, doing CSS parsing in python manually is hard with media queries.
# Let's use a simpler approach for CSS scoping: replace specific root selectors.
# Since we just need to scope "all rules under a .landing wrapper class",
# Maybe we can use node and postcss for css?
