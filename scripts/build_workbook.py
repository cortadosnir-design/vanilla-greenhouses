"""Builds the professional Vanilla greenhouse workbook from the user's original data.

Run: python3 scripts/build_workbook.py  ->  vanilla-greenhouses.xlsx
Sheet names and column order are the contract with apps-script/Code.gs (SHEETS / COLS there).
"""
from datetime import date, datetime
from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.formatting.rule import FormulaRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

OUT = "vanilla-greenhouses.xlsx"
MAX_ROW = 2000  # validation / formatting reach; the script appends below the header

GREEN = "2E6B4F"
LIGHT = "EEF4EF"
FONT = "Arial"
thin = Side(style="thin", color="D5DED7")
BORDER = Border(left=thin, right=thin, top=thin, bottom=thin)
HEAD_FONT = Font(name=FONT, bold=True, color="FFFFFF", size=11)
HEAD_FILL = PatternFill("solid", fgColor=GREEN)
BODY_FONT = Font(name=FONT, size=11)
WRAP = Alignment(horizontal="right", vertical="top", wrap_text=True)
RIGHT = Alignment(horizontal="right", vertical="center")
CENTER = Alignment(horizontal="center", vertical="center")

wb = Workbook()
wb.remove(wb.active)


def sheet(title, headers, widths, rows=(), wrap_cols=(), center_cols=()):
    ws = wb.create_sheet(title)
    ws.sheet_view.rightToLeft = True
    ws.sheet_view.showGridLines = False
    ws.append(headers)
    for r in rows:
        ws.append(list(r))
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    for c in ws[1]:
        c.font, c.fill, c.alignment, c.border = HEAD_FONT, HEAD_FILL, CENTER, BORDER
    ws.row_dimensions[1].height = 30
    for row in ws.iter_rows(min_row=2, max_row=max(ws.max_row, 2)):
        for c in row:
            c.font, c.border = BODY_FONT, BORDER
            col = c.column
            c.alignment = WRAP if col in wrap_cols else CENTER if col in center_cols else RIGHT
    ws.freeze_panes = "A2"
    last = get_column_letter(len(headers))
    ws.auto_filter.ref = f"A1:{last}{max(ws.max_row, 2)}"
    # zebra banding that also covers rows the script appends later
    ws.conditional_formatting.add(
        f"A2:{last}{MAX_ROW}",
        FormulaRule(formula=["AND($A2<>\"\",MOD(ROW(),2)=0)"], fill=PatternFill("solid", fgColor=LIGHT)),
    )
    return ws


def listval(ws, rng, formula, strict=True):
    # strict=False on sheets the script writes to: a rejected appendRow would block the phone's queue
    dv = DataValidation(type="list", formula1=formula, allow_blank=True, showErrorMessage=strict,
                        errorTitle="ערך לא תקין", error="יש לבחור ערך מהרשימה")
    ws.add_data_validation(dv)
    dv.add(rng)


def status_colors(ws, col, mapping):
    for value, color in mapping.items():
        ws.conditional_formatting.add(
            f"{col}2:{col}{MAX_ROW}",
            FormulaRule(formula=[f'${col}2="{value}"'], fill=PatternFill("solid", fgColor=color),
                        font=Font(name=FONT, bold=True), stopIfTrue=True),
        )


YES_NO = '"כן,לא"'

# ---------- חממות: one row per greenhouse (was attributes x greenhouses) ----------
gh_rows = [
    (f"GH{n}", f"חממה {n}", 50, 0.6, 3, 30, f"=E{n+1}*F{n+1}", "Odem", "Vanilla planifolia", 2023,
     "Sprinkler", "Cooler", "Water heating sys", "Fogger", "כן")
    for n in (1, 2, 3)
]
ws = sheet("חממות",
           ["מזהה", "שם", 'שטח (מ"ר)', "סוג מבנה וכיסוי", "מספר שורות", "צמחים לשורה", 'סה"כ צמחים',
            "מצע / שיטת גידול", "זן / מקור", "שנת נטיעה", "השקיה / דישון", "קירור", "חימום", "ערפול", "פעילה"],
           [9, 12, 11, 15, 12, 13, 12, 16, 19, 11, 15, 11, 18, 11, 9], gh_rows, center_cols=(1, 3, 4, 5, 6, 7, 10, 15))
ws["D2"].comment = Comment("הערך 0.6 הועתק כמו שהוא מהגיליון המקורי. לא ברור מה הוא מייצג (אולי אחוז הצללה) - יש לעדכן.", "Claude")
ws["K2"].comment = Comment("תוקן מ-sprinker. גם Fooger תוקן ל-Fogger.", "Claude")
listval(ws, f"O2:O{MAX_ROW}", YES_NO)

# ---------- עבודות ----------
# interval_days: number used for "what's due"; blank = as needed / batch-driven
works = [
    ("W01", "האבקה ופריחה", "האבקה ידנית של פרחים", "זיהוי פרחים שנפתחו בבוקר והאבקה ידנית מדויקת באמצעות קיסם/סיכה לפני סגירת הפרח", "עונת הפריחה (אביב/קיץ)", "יומי בבוקר (06:00-11:00)", 1, "פרחים", "חממה", "לא"),
    ("W02", "האבקה ופריחה", "דילול וספירת פרחים/אשכולות", "הסרת פרחים/תרמילים עודפים באשכול לשמירה על גודל ואיכות תרמילים אופטימלית (8-10 תרמילים לאשכול)", "לאחר האבקה מוצלחת", "לפי הצורך", None, "אשכולות", "חממה", "לא"),
    ("W03", "עיצוב וצימוח", "עיצוב לולאות וליפוף ענפים (Looping)", "הכוונת זמורות הווניל כלפי מטה וליפופן על גבי רשת/חבלי התמיכה לעידוד פריחה ומניעת שבירה", "כל השנה (צימוח פעיל)", "שבועי", 7, None, "חממה", "כן"),
    ("W04", "עיצוב וצימוח", "גיזום וקיטום ציפות (Pruning/Tipping)", "קיטום אמיר הציפה לעידוד הסתעפות, התעבות הזמורה והשראת פריחה", "לפני עונת הפריחה", "עונתי / לפי צורך", 90, None, "חממה", "לא"),
    ("W05", "הזנה ודישון", "יישום דשן בשחרור מבוקר (Slow Release)", "פיזור מבוקר של כדורי דשן (כדוגמת אוסמוקוט) באזור בית השורשים/מצע הגידול", "תחילת עונה / אחת ל-6 חודשים", "חצי שנתי", 180, 'ק"ג', "חממה", "כן"),
    ("W06", "הזנה ודישון", "דישון עלווה / ריסוס הזנה", "ריסוס מיקרו-אלמנטים ודשן עלווה מותאם לחיזוק הנוף", "עונת הצימוח", "חודשי / דו-שבועי", 14, "ליטר", "חממה", "כן"),
    ("W07", "השקיה ואקלים", "שטיפת מצע ובדיקת EC/pH", "מדידת מוליכות חשמלית (EC) ורמת חומציות (pH) בנקז, ושטיפת מצע במים נקיים במקרה של המלחה", "כל השנה", "שבועי", 7, None, "חממה", "כן"),
    ("W08", "השקיה ואקלים", "בדיקת וניקוי טפטפות וערפול", "ביקורת ספיקת טפטפות, ניקוי מסננים ובדיקת מתזים/ערפול לצינון ולחות", "כל השנה (דגש בקיץ)", "שבועי", 7, None, "חממה", "כן"),
    ("W09", "הגנת הצומח", "ניטור מזיקים ומחלות", "סריקה ויזואלית של עלים, גבעולים ושורשים לזיהוי כנימות מגן, אקריות, פוזריום (Fusarium) וריקבון", "כל השנה", "שבועי", 7, None, "חממה", "כן"),
    ("W10", "הגנת הצומח", "ריסוס הדברה מונעת או טיפולית", "יישום תכשירים ביולוגיים/כימיים מורשים נגד פטריות ומזיקים לפי פרוטוקול", "לפי זיהוי / עונתי", "לפי הצורך", None, "ליטר", "חממה", "לא"),
    ("W11", "קטיף ואסיף", "קטיף תרמילים בהבשלה", "זיהוי תרמילים שהצהיבו בקצה התחתון, גזירה זהירה של התרמיל בחיבור לגבעול", "8-9 חודשים מהאבקה", "יומי / דו-שבועי בעונה", 2, "תרמילים", "חממה", "לא"),
    ("W12", "קטיף ואסיף", "מיון, שקילה ושטיפת תרמילים", "ניקוי התרמילים שנאספו, שקילה ראשונית ומיון לפי אורך ואיכות לפני תהליך Curing", "מיד לאחר קטיף", "יומי בעונת הקטיף", 1, 'ק"ג', "מחסן", "לא"),
    ("W13", "תהליך Curing", "חליטה בחום (Killing)", "טבילת התרמילים במים חמים (כ-63-65 מעלות) לזמן קצוב להפסקת התהליכים הביולוגיים", "תחילת Curing", "לפי אצוות קטיף", None, 'ק"ג', "מחסן", "לא"),
    ("W14", "תהליך Curing", "הזעה (Sweating)", "עטיפת התרמילים בשמיכות/קופסאות מבודדות לשמירה על חום ולחות לפיתוח הארומה", "שלב ראשון ב-Curing", "יומי במשך 7-14 ימים", 1, None, "מחסן", "לא"),
    ("W15", "תהליך Curing", "ייבוש ומיון ארומטי", "פריסת התרמילים לייבוש מבוקר עד הגעה לאחוז לחות רצוי (30%-35%)", "שלב שני ב-Curing", "יומי במשך מספר שבועות", 1, None, "מחסן", "לא"),
    ("W16", "תחזוקת תשתיות", "ניקוי ותחזוקת רשתות צל וכיסויים", "בדיקת תקינות יריעות פוליאתילן, רשתות צל, פתחי אוורור ומערכות קירור/חימום", "לפני חורף / לפני קיץ", "עונתי", 90, None, "חממה", "כן"),
]
ws = sheet("עבודות",
           ["קוד", "קטגוריה", "שם העבודה", "תיאור והנחיות ביצוע", "עונה / שלב פנולוגי", "תדירות", "כל כמה ימים",
            "יחידת כמות", "מיקום", "מעקב תדירות"],
           [8, 16, 32, 60, 24, 22, 13, 12, 10, 13], works, wrap_cols=(4,), center_cols=(1, 7, 8, 9, 10))
ws["G1"].comment = Comment("מספר הימים בין ביצוע לביצוע. משמש לחישוב 'מה מגיע היום' בדשבורד. ריק = לפי הצורך.", "Claude")
ws["J1"].comment = Comment("כן = העבודה נכנסת לרשימת 'מה מגיע היום'. לעבודות עונתיות (האבקה, קטיף, Curing) יש להעביר ל'כן' בתחילת העונה.", "Claude")
ws["H1"].comment = Comment("כשיש יחידה, בטופס יופיע שדה כמות לעבודה הזו.", "Claude")
listval(ws, f"I2:I{MAX_ROW}", '"חממה,מחסן"')
listval(ws, f"J2:J{MAX_ROW}", YES_NO)

# ---------- עובדים ----------
ws = sheet("עובדים", ["שם", "טלפון", "פעיל"], [20, 16, 9], [("עובד לדוגמה", None, "כן")], center_cols=(2, 3))
ws["A2"].comment = Comment("שורת דוגמה - להחליף בשמות העובדים. רק עובדים עם 'כן' יופיעו באתר.", "Claude")
listval(ws, f"C2:C{MAX_ROW}", YES_NO)

# ---------- יומן עבודה ----------
LOG_HEAD = ["מזהה", "תאריך", "עובד", "חממה", "קוד עבודה", "עבודה", "קטגוריה", "כניסה", "יציאה", "שעות",
            "כמות", "יחידה", "הערות", "תמונה", "סטטוס", "עודכן"]
ws = sheet("יומן עבודה", LOG_HEAD, [16, 12, 14, 11, 11, 30, 16, 9, 9, 8, 9, 9, 36, 14, 10, 18],
           [("L-0001", date(2026, 10, 31), "מגדל", "חממה 1", None, None, None, datetime(2026, 10, 31, 16, 48), datetime(2026, 10, 31, 16, 48),
             "=IF(OR(H2=\"\",I2=\"\"),\"\",ROUND((I2-H2)*24,2))", None, None,
             "רשומת בדיקה מהמערכת הקודמת. העלאת התמונה נכשלה (חסרה הרשאת Drive).", None, "סגור", None)],
           wrap_cols=(13,), center_cols=(1, 2, 4, 5, 8, 9, 10, 11, 12, 15))
for col, fmt in (("B", "dd/mm/yyyy"), ("H", "hh:mm"), ("I", "hh:mm"), ("J", "0.00"), ("P", "dd/mm/yyyy hh:mm")):
    for r in range(2, 3):
        ws[f"{col}{r}"].number_format = fmt
listval(ws, f"C2:C{MAX_ROW}", "=עובדים!$A$2:$A$200", strict=False)
listval(ws, f"D2:D{MAX_ROW}", "=חממות!$B$2:$B$50", strict=False)
listval(ws, f"E2:E{MAX_ROW}", "=עבודות!$A$2:$A$100", strict=False)
listval(ws, f"O2:O{MAX_ROW}", '"פתוח,סגור"', strict=False)
status_colors(ws, "O", {"פתוח": "FFF4CC"})

# ---------- נוכחות (שעון כניסה ויציאה יומי) ----------
ws = sheet("נוכחות", ["מזהה", "תאריך", "עובד", "כניסה", "יציאה", "שעות", "סטטוס"], [16, 12, 14, 9, 9, 8, 10],
           center_cols=(1, 2, 4, 5, 6, 7))
ws["A1"].comment = Comment("שורה לכל יום עבודה: נוצרת בלחיצה על 'כניסה לעבודה' ונסגרת ב'יציאה מהעבודה'.", "Claude")
listval(ws, f"C2:C{MAX_ROW}", "=עובדים!$A$2:$A$200", strict=False)
listval(ws, f"G2:G{MAX_ROW}", '"פתוח,סגור"', strict=False)
status_colors(ws, "G", {"פתוח": "FFF4CC"})

# ---------- תמונות (המנהל מעלה מהדשבורד) ----------
ws = sheet("תמונות", ["מזהה", "תאריך", "חממה", "הערה", "תמונה", 'הועלה ע"י'], [16, 12, 11, 36, 40, 14],
           wrap_cols=(4, 5), center_cols=(1, 2, 3))
listval(ws, f"C2:C{MAX_ROW}", "=חממות!$B$2:$B$50", strict=False)

# ---------- משימות (עבודות עתידיות) ----------
ws = sheet("משימות", ["מזהה", "תאריך ביצוע", "חממה", "משימה", "קוד עבודה", "עובד", "סטטוס", "נוצר", "בוצע", 'בוצע ע"י'],
           [16, 13, 11, 36, 11, 14, 10, 17, 17, 14], wrap_cols=(4,), center_cols=(1, 2, 3, 5, 7, 8, 9))
ws["B1"].comment = Comment("המנהל מוסיף משימות מהדשבורד (כפתור 'עבודות עתידיות'). העובדים רואים את המשימות של השבוע הקרוב במסך הדיווח.", "Claude")
listval(ws, f"C2:C{MAX_ROW}", "=חממות!$B$2:$B$50", strict=False)
listval(ws, f"F2:F{MAX_ROW}", "=עובדים!$A$2:$A$200", strict=False)
listval(ws, f"G2:G{MAX_ROW}", '"פתוח,בוצע"', strict=False)
status_colors(ws, "G", {"בוצע": "DFF2E1"})

# ---------- בעיות ----------
ws = sheet("בעיות",
           ["מזהה", "תאריך", "חממה", "מדווח", "קטגוריה", "חומרה", "תיאור", "תמונה", "סטטוס", "תאריך טיפול",
            "טופל ע\"י", "פתרון"],
           [16, 12, 11, 14, 13, 10, 40, 14, 10, 13, 14, 36], wrap_cols=(7, 12), center_cols=(1, 2, 3, 5, 6, 9, 10))
listval(ws, f"C2:C{MAX_ROW}", "=חממות!$B$2:$B$50", strict=False)
listval(ws, f"E2:E{MAX_ROW}", '"מזיקים,מחלה,השקיה,אקלים,תשתית,אחר"', strict=False)
listval(ws, f"F2:F{MAX_ROW}", '"נמוכה,בינונית,גבוהה"', strict=False)
listval(ws, f"I2:I{MAX_ROW}", '"פתוח,בטיפול,טופל"', strict=False)
status_colors(ws, "I", {"פתוח": "FDE2E2", "בטיפול": "FFF4CC", "טופל": "DFF2E1"})
status_colors(ws, "F", {"גבוהה": "FDE2E2"})

# ---------- סיכום (formulas only) ----------
L = "'יומן עבודה'"
ws = sheet("סיכום", ["חממה", "שעות החודש", 'שעות סה"כ', "פרחים שהואבקו", "תרמילים שנקטפו", "בעיות פתוחות", "טיפול אחרון"],
           [14, 13, 12, 15, 15, 14, 14], center_cols=(2, 3, 4, 5, 6, 7))
month_start = '">="&DATE(YEAR(TODAY()),MONTH(TODAY()),1)'
for i in range(2, 12):  # room for 10 greenhouses
    a = f"A{i}"
    ws[a] = f'=IF(חממות!B{i}="","",חממות!B{i})'
    ws[f"B{i}"] = f'=IF({a}="","",SUMIFS({L}!$J:$J,{L}!$D:$D,{a},{L}!$B:$B,{month_start}))'
    ws[f"C{i}"] = f'=IF({a}="","",SUMIFS({L}!$J:$J,{L}!$D:$D,{a}))'
    ws[f"D{i}"] = f'=IF({a}="","",SUMIFS({L}!$K:$K,{L}!$D:$D,{a},{L}!$E:$E,"W01"))'
    ws[f"E{i}"] = f'=IF({a}="","",SUMIFS({L}!$K:$K,{L}!$D:$D,{a},{L}!$E:$E,"W11"))'
    ws[f"F{i}"] = f'=IF({a}="","",COUNTIFS(בעיות!$C:$C,{a},בעיות!$I:$I,"<>טופל"))'
    ws[f"G{i}"] = f'=IF({a}="","",IF(COUNTIFS({L}!$D:$D,{a})=0,"",_xlfn.MAXIFS({L}!$B:$B,{L}!$D:$D,{a})))'
    ws[f"G{i}"].number_format = "dd/mm/yyyy"
    for c in ws[i]:
        c.font, c.border, c.alignment = BODY_FONT, BORDER, CENTER
for col in "BC":
    for i in range(2, 12):
        ws[f"{col}{i}"].number_format = "0.0"

ws["I1"], ws["J1"], ws["K1"] = "עובד", "שעות החודש", 'שעות סה"כ'
for c in (ws["I1"], ws["J1"], ws["K1"]):
    c.font, c.fill, c.alignment, c.border = HEAD_FONT, HEAD_FILL, CENTER, BORDER
for i in range(2, 32):  # room for 30 workers
    a = f"I{i}"
    ws[a] = f'=IF(עובדים!A{i}="","",עובדים!A{i})'
    ws[f"J{i}"] = f'=IF({a}="","",SUMIFS({L}!$J:$J,{L}!$C:$C,{a},{L}!$B:$B,{month_start}))'
    ws[f"K{i}"] = f'=IF({a}="","",SUMIFS({L}!$J:$J,{L}!$C:$C,{a}))'
    for col in "IJK":
        c = ws[f"{col}{i}"]
        c.font, c.border, c.alignment = BODY_FONT, BORDER, CENTER
        if col != "I":
            c.number_format = "0.0"
ws.column_dimensions["H"].width = 3
for col, w in (("I", 16), ("J", 13), ("K", 12)):
    ws.column_dimensions[col].width = w
ws.auto_filter.ref = None
ws.conditional_formatting = type(ws.conditional_formatting)()  # summary needs no zebra

# ---------- QR ----------
ws = sheet("QR", ["חממה", "קישור לדיווח"], [14, 70], center_cols=(1,))
for i in range(2, 12):
    ws[f"A{i}"] = f'=IF(חממות!A{i}="","",חממות!B{i})'
    ws[f"B{i}"] = f'=IF(חממות!A{i}="","",הגדרות!$B$2&"?gh="&חממות!A{i})'
    for c in ws[i]:
        c.font, c.border, c.alignment = BODY_FONT, BORDER, RIGHT

# ---------- מזג אוויר (the daily trigger appends one row per day) ----------
ws = sheet("מזג אוויר", ["תאריך", "טמפ' מקס'", "טמפ' מינ'", "לחות מקס'", "לחות מינ'", 'גשם (מ"מ)', 'רוח מקס\' (קמ"ש)'],
           [12, 11, 11, 11, 11, 11, 15], center_cols=(1, 2, 3, 4, 5, 6, 7))
ws["A1"].comment = Comment("מתמלא אוטומטית כל בוקר מתחזית ECMWF לשניר (Open-Meteo). שורה ליום.", "Claude")

# ---------- הגדרות ----------
ws = sheet("הגדרות", ["הגדרה", "ערך"], [26, 80], [
    ("כתובת האתר", "https://cortadosnir-design.github.io/vanilla-greenhouses/"),
    ("כתובת השרת (Apps Script)", "https://script.google.com/macros/s/AKfycbxP7DvkjU8crnOuLvWvIH-RM_BPHeptRKY71NULynNjPMDs7wOwv2kSPshXtodEdLbLxQ/exec"),
    ("מזהה תיקיית תמונות ב-Drive", ""),
    ("קוד עובדים", "1234"),
    ("קוד מנהל", "9876"),
    ("אימייל לעדכון יומי", ""),
])
ws["B7"].comment = Comment("כתובת לקבלת תחזית ואזהרות כל בוקר ב-06:00. ריק = בלי מייל. (דורש הרצה חד-פעמית של installTriggers בסקריפט.)", "Claude")
ws["B4"].comment = Comment("להדביק כאן את המזהה מכתובת התיקייה ב-Drive (החלק שאחרי folders/). ריק = הסקריפט ייצור תיקייה בעצמו.", "Claude")
ws["B5"].comment = Comment("קוד זמני - להחליף לקוד ארוך יותר (אותיות ומספרים). העובדים מקלידים אותו פעם אחת במכשיר.", "Claude")
ws["B6"].comment = Comment("קוד זמני - להחליף לקוד ארוך יותר. נדרש לכניסה לדשבורד.", "Claude")
yellow = PatternFill("solid", fgColor="FFF4CC")
for r in range(4, 8):
    ws[f"B{r}"].fill = yellow
ws.conditional_formatting = type(ws.conditional_formatting)()

wb.save(OUT)
print("saved", OUT)
