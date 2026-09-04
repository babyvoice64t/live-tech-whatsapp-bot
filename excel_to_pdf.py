import sys, openpyxl
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor, white, black
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader

# Usage: python excel_to_pdf.py in.xlsx out.pdf
inp = sys.argv[1]
out = sys.argv[2]

wb = openpyxl.load_workbook(inp, data_only=True)
ws = wb['Sales Invoice'] if 'Sales Invoice' in wb.sheetnames else wb.active

def val(cell):
    v = ws[cell].value
    return '' if v is None else str(v).strip()

date = val('H6')
inv_no = val('H7')
client = val('F10')
brand = val('C19')
desc = val('D19')
qty = val('E19')
rate = val('F19')
line = val('H19')
subtotal = val('H41')
total = val('H43')
words = val('D44')

# Fallback to calc if empty
try:
    if not line or line=='0':
        line = str(float(qty or 0)*float(rate or 0))
        subtotal = line
        total = line
except:
    pass

# Colors like template
accent = HexColor('#0E4D2A')
dark = HexColor('#0F172A')
gray = HexColor('#475569')
light = HexColor('#F1F5F9')
border = HexColor('#E2E8F0')
border2 = HexColor('#CBD5E1')

c = canvas.Canvas(out, pagesize=A4)
W, H = A4

# Outer border
c.setStrokeColor(border2)
c.setLineWidth(0.7)
c.rect(24, 24, 547, 794, stroke=1, fill=0)
# Top accent
c.setFillColor(accent)
c.rect(24, 815, 547, 3, stroke=0, fill=1)

# Company block - same as Excel header
c.setFillColor(dark)
c.setFont('Helvetica-Bold', 11)
c.drawString(32, H-34, 'UA International')
c.setFont('Helvetica', 7)
c.setFillColor(HexColor('#475569'))
c.drawString(32, H-48, 'IT Solution provider')
c.setFillColor(HexColor('#334155'))
c.drawString(32, H-60, '9 Floor Office # 905 Uni Center,')
c.drawString(32, H-70, 'II Chundrigar Road Karachi.')

c.setFillColor(dark)
c.setFont('Helvetica-Bold', 22)
c.drawRightString(W-32, H-34, 'INVOICE')

c.setFont('Helvetica', 8)
c.setFillColor(HexColor('#334155'))
c.drawRightString(W-32-80, H-62, 'Date:')
c.setFont('Helvetica-Bold', 8)
c.setFillColor(dark)
c.drawString(W-32-65, H-62, date)
c.setFont('Helvetica', 8)
c.setFillColor(HexColor('#334155'))
c.drawRightString(W-32-80, H-76, 'Invoice #:')
c.setFont('Helvetica-Bold', 8)
c.setFillColor(dark)
c.drawString(W-32-65, H-76, inv_no)

# Divider
c.setStrokeColor(border)
c.setLineWidth(0.5)
c.line(32, H-92, W-32, H-92)

# Bill To
c.setFillColor(accent)
c.setFont('Helvetica-Bold', 8)
c.drawString(32, H-100, 'Bill To:')
c.setFillColor(dark)
c.setFont('Helvetica', 9)
c.drawString(32, H-112, client or 'Walk-in Client')
c.setFillColor(HexColor('#475569'))
c.setFont('Helvetica', 7)
c.drawString(32, H-126, 'Client')
c.setFillColor(HexColor('#64748B'))
c.drawRightString(W-32, H-112, 'Payment Terms: 30 Days')

# Sales Details light header
sdTop = H-142
c.setFillColor(light)
c.rect(32, sdTop-14, 531, 14, stroke=0, fill=1)
c.setStrokeColor(border)
c.rect(32, sdTop-14, 531, 14, stroke=1, fill=0)
c.setFillColor(gray)
c.setFont('Helvetica-Bold', 6)
c.drawString(36, sdTop-9, 'Job')
c.drawString(120, sdTop-9, 'Shipping Method')
c.drawString(210, sdTop-9, 'Shipping Terms')
c.drawString(300, sdTop-9, 'Delivery Date')
c.drawString(380, sdTop-9, 'Payment Terms')
c.drawString(460, sdTop-9, 'Due Date')

# Table header dark
top = H-162
c.setFillColor(dark)
c.rect(32, top-18, 531, 18, stroke=0, fill=1)
c.setFillColor(white)
c.setFont('Helvetica-Bold', 7)
c.drawCentredString(34+14, top-12, 'S/No')
c.drawCentredString(64+30, top-12, 'Brand')
c.drawCentredString(126+95, top-12, 'Description')
c.drawCentredString(316+20, top-12, 'Qty')
c.drawCentredString(356+32, top-12, 'Unit Price')
c.drawCentredString(421+27, top-12, 'Discount')
c.drawCentredString(476+40, top-12, 'Line Total')

# Grid - single row (as filled)
rowH = 18
rows = 1
for i in range(rows):
    y = top-18 - i*rowH
    c.setStrokeColor(border)
    c.setLineWidth(0.4)
    c.rect(32, y-rowH, 531, rowH, stroke=1, fill=0)
    # verticals
    c.line(62, y, 62, y-rowH)
    c.line(124, y, 124, y-rowH)
    c.line(314, y, 314, y-rowH)
    c.line(354, y, 354, y-rowH)
    c.line(419, y, 419, y-rowH)
    c.line(474, y, 474, y-rowH)

y0 = top-18-13
c.setFillColor(dark)
c.setFont('Helvetica', 7)
c.drawCentredString(34+14, y0, '1')
c.drawCentredString(64+30, y0, brand or '-')
# description may be long, clip
c.drawString(128, y0, desc[:40])
c.drawCentredString(316+20, y0, qty)
try:
    rate_fmt = "{:,}".format(float(rate)) if rate else rate
except:
    rate_fmt = rate
c.drawCentredString(356+32, y0, rate_fmt)
c.drawCentredString(421+27, y0, '0')
c.setFont('Helvetica-Bold', 7)
try:
    line_fmt = "{:.2f}".format(float(line)) if line else line
except:
    line_fmt = line
c.drawCentredString(476+40, y0, line_fmt)

# Totals
tTop = top-18 - rows*rowH - 6
c.setStrokeColor(border)
c.rect(380, tTop-36, 183, 36, stroke=1, fill=0)
c.line(460, tTop, 460, tTop-36)
c.line(380, tTop-18, 563, tTop-18)
c.setFillColor(HexColor('#475569'))
c.setFont('Helvetica', 7)
c.drawRightString(458, tTop-12, 'Subtotal')
c.setFillColor(dark)
c.setFont('Helvetica-Bold', 7)
c.drawCentredString(460+45, tTop-12, line_fmt)
c.setFillColor(HexColor('#0E4D2A'))
c.setFont('Helvetica-Bold', 7)
c.drawRightString(458, tTop-30, 'Total')
c.drawCentredString(460+45, tTop-30, line_fmt)

# Amount in words
c.setFillColor(HexColor('#334155'))
c.setFont('Helvetica', 7)
c.drawString(32, tTop-8, 'Amount In Words:')
c.setFillColor(dark)
c.setFont('Helvetica-Bold', 8)
c.drawString(32, tTop-20, words or '')

# Thank you
c.setFillColor(accent)
c.setFont('Helvetica-Oblique', 9)
c.drawCentredString(W/2, tTop-50, 'Thank you for your business!')

# Footer
c.setFillColor(HexColor('#94A3B8'))
c.setFont('Helvetica', 6)
c.drawCentredString(W/2, 32, 'UA International \u2022 IT Solution provider \u2022 Generated by Live Tech Backup System')

c.showPage()
c.save()
print('pdf saved')
