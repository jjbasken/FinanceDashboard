import datetime, os
from gnucash import Session, SessionOpenMode, Account, Transaction, Split, GncNumeric, GncCommodity, GncPrice
from gnucash import gnucash_core_c as C

def build(url):
    s = Session(url, SessionOpenMode.SESSION_NEW_STORE)
    book = s.book
    ct = book.get_table()
    usd = ct.lookup("CURRENCY", "USD")
    aapl = GncCommodity(book, "Apple Inc.", "NASDAQ", "AAPL", "AAPL", 1000)
    fund = GncCommodity(book, "Spartan Total Market", "FUND", "SP TTL MRKT", "", 1000)
    ct.insert(aapl); ct.insert(fund)
    root = book.get_root_account()

    def acct(name, typ, parent, commodity=usd, placeholder=False, hidden=False):
        a = Account(book)
        a.BeginEdit(); a.SetName(name); a.SetType(typ); a.SetCommodity(commodity)
        if placeholder: a.SetPlaceholder(True)
        if hidden: a.SetHidden(True)
        parent.append_child(a); a.CommitEdit()
        return a

    assets = acct("Assets", C.ACCT_TYPE_ASSET, root, placeholder=True)
    checking = acct("Checking", C.ACCT_TYPE_BANK, assets)
    old = acct("Old Savings", C.ACCT_TYPE_BANK, assets, hidden=True)
    brokerage = acct("Brokerage", C.ACCT_TYPE_ASSET, assets)
    a_aapl = acct("AAPL", C.ACCT_TYPE_STOCK, brokerage, aapl)
    a_fund = acct("Spartan Total Market", C.ACCT_TYPE_MUTUAL, brokerage, fund)
    liab = acct("Liabilities", C.ACCT_TYPE_LIABILITY, root, placeholder=True)
    visa = acct("Visa", C.ACCT_TYPE_CREDIT, liab)
    income = acct("Income", C.ACCT_TYPE_INCOME, root, placeholder=True)
    salary = acct("Salary", C.ACCT_TYPE_INCOME, income)
    expenses = acct("Expenses", C.ACCT_TYPE_EXPENSE, root, placeholder=True)
    groceries = acct("Groceries", C.ACCT_TYPE_EXPENSE, expenses)
    auto = acct("Auto", C.ACCT_TYPE_EXPENSE, expenses, placeholder=True)
    fuel = acct("Fuel", C.ACCT_TYPE_EXPENSE, auto)
    equity = acct("Equity", C.ACCT_TYPE_EQUITY, root, placeholder=True)
    opening = acct("Opening Balances", C.ACCT_TYPE_EQUITY, equity)

    def tx(d, desc, splits, notes=None, num=None, void=None):
        t = Transaction(book)
        t.BeginEdit(); t.SetCurrency(usd); t.SetDate(d.day, d.month, d.year); t.SetDescription(desc)
        if num: t.SetNum(num)
        for (a, cents, qty, memo, rec) in splits:
            sp = Split(book); sp.SetParent(t); sp.SetAccount(a)
            sp.SetValue(GncNumeric(cents, 100))
            sp.SetAmount(GncNumeric(qty[0], qty[1]) if qty else GncNumeric(cents, 100))
            if memo: sp.SetMemo(memo)
            if rec: sp.SetReconcile(rec)
        t.CommitEdit()
        if notes: t.BeginEdit(); t.SetNotes(notes); t.CommitEdit()
        if void: t.Void(void)
        return t

    D = datetime.date
    tx(D(2026,1,1), "Opening Balance", [(checking, 500000, None, "", "y"), (opening, -500000, None, "", "n")])
    tx(D(2026,1,5), "Smith & Sons <Grocer>", [(checking, -8250, None, "debit & card", "c"), (groceries, 8250, None, "", "n")], notes="weekly shop", num="1001")
    tx(D(2026,1,15), "Acme Corp", [(salary, -300000, None, "", "n"), (checking, 300000, None, "", "n")])
    tx(D(2026,1,20), "Move to brokerage", [(checking, -200000, None, "", "n"), (brokerage, 200000, None, "", "n")])
    tx(D(2026,2,1), "Buy AAPL", [(brokerage, -100000, None, "", "n"), (a_aapl, 100000, (5000, 1000), "", "n")])
    tx(D(2026,2,2), "Buy fund", [(brokerage, -100000, None, "", "n"), (a_fund, 100000, (4367, 1000), "", "n")])
    tx(D(2026,3,1), "Sell AAPL", [(a_aapl, -50000, (-2000, 1000), "", "n"), (brokerage, 50000, None, "", "n")])
    tx(D(2026,3,5), "Gas Station", [(visa, -4567, None, "", "n"), (fuel, 4567, None, "", "n")])
    tx(D(2026,3,6), "Mistake", [(checking, -1000, None, "", "n"), (groceries, 1000, None, "", "n")], void="Entered twice")

    pdb = book.get_price_db()
    for commodity, cents in ((aapl, 26000), (fund, 23000)):
        p = GncPrice(book); p.begin_edit()
        p.set_commodity(commodity); p.set_currency(usd)
        p.set_time64(datetime.datetime(2026, 3, 31, 10, 59, 0))
        p.set_value(GncNumeric(cents, 100)); p.set_source_string("user:price"); p.set_typestr("last")
        pdb.add_price(p); p.commit_edit()

    s.save(); s.end(); s.destroy()

out = "/out"  # docker run -v <this folder>:/out fd-gnctools python3 /out/make.py
for f in ("book-xml.gnucash", "book.sqlite"):
    if os.path.exists(f"{out}/{f}"): os.remove(f"{out}/{f}")
build(f"xml://{out}/book-xml.gnucash")
build(f"sqlite3://{out}/book.sqlite")
print("written", sorted(os.listdir(out)))
