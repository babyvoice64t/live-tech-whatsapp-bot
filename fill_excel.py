import openpyxl, sys, json
# Usage: python fill_excel.py template.xlsm out.xlsx '{"date":"04-09-2026","invoiceNo":"9999","client":"Test","description":"Desc","qty":"1","rate":"100","brand":"B","words":"One Only"}'
tpl = sys.argv[1]
out = sys.argv[2]
data = json.loads(sys.argv[3])
wb = openpyxl.load_workbook(tpl, keep_vba=True)
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
try:
    # openpyxl stores tables in ws._tables
    if hasattr(ws, '_tables'):
        ws._tables = []
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
wb.save(out)
print('saved')
