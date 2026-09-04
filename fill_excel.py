import openpyxl, sys, json
from openpyxl.styles import PatternFill, Font, Alignment, Border, Side
# Usage: python fill_excel.py template.xlsm out.xlsx '{"date":"04-09-2026","invoiceNo":"9999","client":"Test","description":"Desc","qty":"1","rate":"100","brand":"B","words":"One Only"}'
tpl = sys.argv[1]
out = sys.argv[2]
data = json.loads(sys.argv[3])
wb = openpyxl.load_workbook(tpl, keep_vba=False)
# Keep only Sales Invoice
keep='Sales Invoice'
for name in list(wb.sheetnames):
    if name!=keep:
        ws=wb[name]
        wb.remove(ws)
ws=wb[keep]
# Remove images (2 logos on right) - clear _images
try:
    ws._images = []
except:
    pass
# Fix AutoFilter/Table - remove to avoid Repaired Records error
try:
    ws.auto_filter = None
except:
    pass
# Clear tables correctly (openpyxl _tables is dict-like)
try:
    if hasattr(ws, '_tables'):
        try:
            ws._tables.clear()
        except:
            ws._tables = {}
except:
    pass
try:
    if hasattr(ws, 'tables'):
        try:
            ws.tables.clear()
        except:
            pass
except:
    pass
# Hide extra rows 20-38
try:
    for r in range(20, 39):
        ws.row_dimensions[r].hidden = True
        ws.row_dimensions[r].height = 0
    ws.print_area = 'A1:H44'
    ws.page_setup.fitToPage = True
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 1
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_setup.horizontalCentered = True
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
except:
    pass
# Re-apply header style for B18:H18 (lost when tables removed) - dark header white text
try:
    hdr_fill = PatternFill(start_color="0F172A", end_color="0F172A", fill_type="solid")
    hdr_font = Font(name="Century Gothic", size=11, bold=True, color="FFFFFF")
    hdr_align = Alignment(horizontal="center", vertical="center")
    thin = Side(style="thin", color="E2E8F0")
    hdr_border = Border(left=thin, right=thin, top=thin, bottom=thin)
    for col in ['B','C','D','E','F','G','H']:
        c = ws[col+'18']
        c.fill = hdr_fill
        c.font = hdr_font
        c.alignment = hdr_align
        c.border = hdr_border
    ws.row_dimensions[18].height = 18
except:
    pass
# Fill
try: ws['H6'] = data.get('date','')
except: pass
try: ws['H7'] = str(data.get('invoiceNo',''))
except: pass
try: ws['F10'] = data.get('client','Walk-in Client')
except: pass
try: ws['B19'] = 1
except: pass
try: ws['C19'] = data.get('brand','')
except: pass
try: ws['D19'] = data.get('description','')
except: pass
try: ws['E19'] = int(data.get('qty',0)) if str(data.get('qty','')).isdigit() else float(data.get('qty',0))
except: pass
try: ws['F19'] = float(data.get('rate',0))
except: pass
try: ws['G19'] = 0
except: pass
lineTotal = float(data.get('qty',0) or 0) * float(data.get('rate',0) or 0)
try: ws['H19'] = lineTotal
except: pass
try: ws['H41'] = lineTotal
except: pass
try: ws['H43'] = lineTotal
except: pass
try: ws['D44'] = data.get('words','')
except: pass
# Ensure no VBA for xlsx
try:
    wb.vba_archive = None
except:
    pass
wb.save(out)
print('saved')
