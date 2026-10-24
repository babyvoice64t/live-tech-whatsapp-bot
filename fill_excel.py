import openpyxl, sys, json
from openpyxl.styles import PatternFill, Font, Alignment, Border, Side
# Usage: python fill_excel.py template.xlsm out.xlsx '{"date":"04-09-2026","invoiceNo":"9999","client":"Test","description":"Desc","qty":"1","rate":"100","brand":"B","words":"One Only"}'
tpl = sys.argv[1]
out = sys.argv[2]
data = json.loads(sys.argv[3])
wb = openpyxl.load_workbook(tpl, keep_vba=False)
# Kill external links + defined names FIRST (dangling refs = "repaired records" errors)
try:
    wb._external_links = []
except:
    pass
try:
    for n in list(wb.defined_names):
        try:
            del wb.defined_names[n]
        except:
            pass
except:
    pass
# Keep only Sales Invoice (chartsheets ko pehle hatao, warna corrupt)
keep='Sales Invoice'
try:
    for name in list(wb.sheetnames):
        if name != keep:
            wsx = wb[name]
            try:
                wsx.sheet_state = 'visible'
            except:
                pass
            wb.remove(wsx)
except:
    pass
ws=wb[keep]
# Active sheet fix (warna Excel ajeeb tab/zoom kholta hai)
try:
    wb.active = wb.sheetnames.index(keep)
except:
    pass
# Remove images (2 logos on right) - clear _images
try:
    ws._images = []
except:
    pass
try:
    ws._drawing = None
except:
    pass
# Fix AutoFilter/Table - remove to avoid Repaired Records error (template ka filter toota hua hai)
try:
    ws.auto_filter = None
except:
    pass
try:
    ws._auto_filter = None
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
# Clear data-validations + conditional formatting (purani refs = repair errors)
try:
    ws.data_validations.dataValidation = []
except:
    pass
try:
    if hasattr(ws.conditional_formatting, '_cf_rules'):
        ws.conditional_formatting._cf_rules = {}
except:
    pass
# Zoom normal (full-zoom bug fix) + gridlines on
try:
    ws.sheet_view.zoomScale = 100
except:
    pass
try:
    ws.sheet_view.zoomScaleNormal = 100
except:
    pass
# Hide extra rows 20-38 + page setup (guarded: template may lack sheetPr,
# which used to silently kill this whole block -> no print area, no fit)
for r in range(20, 39):
    ws.row_dimensions[r].hidden = True
    ws.row_dimensions[r].height = 0
try:
    from openpyxl.worksheet.properties import WorksheetProperties, PageSetupProperties
    if getattr(ws, 'sheet_properties', None) is None:
        ws.sheet_properties = WorksheetProperties()
    if ws.sheet_properties.pageSetUpPr is None:
        ws.sheet_properties.pageSetUpPr = PageSetupProperties()
    ws.sheet_properties.pageSetUpPr.fitToPage = True
except Exception:
    pass
try:
    ws.page_setup.orientation = 'portrait'
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 1
    ws.page_setup.horizontalCentered = True
    ws.page_margins.left = 0.4
    ws.page_margins.right = 0.4
    ws.page_margins.top = 0.5
    ws.page_margins.bottom = 0.5
    ws.print_area = 'A1:H46'
    ws.print_options.horizontalCentered = True
except Exception:
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
# Blank template instruction cells in col A (notes, not data) + B15 'Column1'
# placeholder, so none of them can ever overflow into the printed invoice
for _a in ['A5','A6','A7','A8','A9','A15','A18','A51','A52','A53']:
    try: ws[_a] = ''
    except: pass
try: ws['B15'] = ''
except: pass
try: ws['H6'] = data.get('date','')
except: pass
try: ws['H7'] = str(data.get('invoiceNo',''))
except: pass
try:
    ws['F10'] = data.get('client','Walk-in Client')
    ws['F10'].alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)
    import math as _math
    _cl = max(1, _math.ceil(len(str(data.get('client',''))) / 40))
    ws.row_dimensions[10].height = max(15, _cl * 17.5 + 4)
except: pass
# Items - multi
items = data.get('items')
if not items:
    # fallback single
    items = [{'brand': data.get('brand',''), 'description': data.get('description',''), 'qty': data.get('qty',0), 'rate': data.get('rate',0), 'disc': 0}]
# Normalize
norm=[]
for it in items:
    try:
        qty = float(it.get('qty',0) or 0)
        rate = float(it.get('rate',0) or 0)
        disc = float(it.get('disc',0) or 0)
        line = qty*rate - disc
        norm.append({'brand': it.get('brand',''), 'description': it.get('description',''), 'qty': qty, 'rate': rate, 'disc': disc, 'line': line})
    except:
        pass
if not norm:
    norm=[{'brand':'','description':'','qty':0,'rate':0,'disc':0,'line':0}]
# Fill rows B19:H.. with alternating blue/white 12pt
blue_fill = PatternFill(start_color="D5E0EA", end_color="D5E0EA", fill_type="solid")
white_fill = PatternFill(start_color="FFFFFF", end_color="FFFFFF", fill_type="solid")
light_border = Border(left=Side(style="thin", color="E2E8F0"), right=Side(style="thin", color="E2E8F0"), top=Side(style="thin", color="E2E8F0"), bottom=Side(style="thin", color="E2E8F0"))
bottom_thick = Border(left=Side(style="thin", color="E2E8F0"), right=Side(style="thin", color="E2E8F0"), top=Side(style="thin", color="E2E8F0"), bottom=Side(style="medium", color="0F172A"))
for idx, it in enumerate(norm):
    r = 19 + idx
    fill = white_fill if (idx % 2 == 0) else blue_fill
    is_last = (idx == len(norm)-1)
    border = bottom_thick if is_last else light_border
    try: ws[f'B{r}'] = idx+1
    except: pass
    try: ws[f'C{r}'] = it['brand']
    except: pass
    try: ws[f'D{r}'] = it['description']
    except: pass
    try: ws[f'E{r}'] = it['qty']
    except: pass
    try: ws[f'F{r}'] = it['rate']
    except: pass
    try: ws[f'G{r}'] = it['disc']
    except: pass
    try: ws[f'H{r}'] = it['line']
    except: pass
    ws.row_dimensions[r].hidden=False
    # Wrap long descriptions instead of clipping them (D col ~38 chars/line
    # at Century Gothic 12) and grow the row to fit
    import math as _math
    _lines = max(1, _math.ceil(len(str(it['description'])) / 36))
    ws.row_dimensions[r].height = max(16, _lines * 17.5 + 4)
    for col in ['B','C','D','E','F','G','H']:
        c=ws[f'{col}{r}']
        c.fill=fill
        c.font=Font(name="Century Gothic", size=12, color="0F172A")
        c.alignment=Alignment(horizontal="center" if col in ['B','E','F','G','H'] else "left", vertical="center", wrap_text=(col == 'D'))
        c.border=border
# Hide remaining rows after items
for r in range(19+len(norm), 39):
    try:
        ws.row_dimensions[r].hidden=True
        ws.row_dimensions[r].height=0
        for col in ['B','C','D','E','F','G','H']:
            ws[f'{col}{r}'].value=None
    except: pass
subtotal = sum(it['line'] for it in norm)
try: ws['H41'] = subtotal
except: pass
try: ws['H43'] = subtotal
except: pass
try: ws['D44'] = data.get('words','')
except: pass
# H41/H43 blue like subtotal
try:
    for c in [ws['H41'], ws['H43']]:
        c.fill=blue_fill
        c.font=Font(name="Century Gothic", size=11, bold=True, color="0F172A")
except: pass
# Ensure no VBA for xlsx
try:
    wb.vba_archive = None
except:
    pass
wb.save(out)
# Strip template logos at the ZIP level: openpyxl image removal is unreliable
# across versions, and any leftover drawing prints on the invoice.
try:
    import zipfile as _zf, re as _re, os as _os
    _tmp = out + '.nostrip'
    _zin = _zf.ZipFile(out, 'r')
    _names = _zin.namelist()
    _keep = [n for n in _names if not n.startswith('xl/drawings/') and not n.startswith('xl/media/')]
    _zout = _zf.ZipFile(_tmp, 'w', _zf.ZIP_DEFLATED)
    for _n in _keep:
        _data = _zin.read(_n)
        if _n.startswith('xl/worksheets/sheet') and _n.endswith('.xml'):
            _data = _re.sub(rb'<drawing[^>]*/>', b'', _data)
            _data = _re.sub(rb'<drawing[^>]*>.*?</drawing>', b'', _data, flags=_re.S)
        elif _n.startswith('xl/worksheets/_rels/') and _n.endswith('.rels'):
            _data = _re.sub(rb'<Relationship[^>]*Type="[^"]*/drawing"[^>]*/>', b'', _data)
        elif _n == '[Content_Types].xml':
            _data = _re.sub(rb'<Override[^>]*PartName="/xl/(drawings|media)/[^"]*"[^>]*/>', b'', _data)
        _zout.writestr(_n, _data)
    _zout.close(); _zin.close()
    _os.replace(_tmp, out)
except Exception as _e:
    print('logo strip skipped:', _e)
print('saved')
