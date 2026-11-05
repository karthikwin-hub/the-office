"""Master data for the sample business. Every name is fictional."""

from money import make_gstin

STATES = {
    "27": "Maharashtra",
    "29": "Karnataka",
    "30": "Goa",
    "24": "Gujarat",
    "36": "Telangana",
    "23": "Madhya Pradesh",
    "07": "Delhi",
}

BUSINESS = {
    "id": "kaveri",
    "name": "Kaveri Electricals",
    "legalName": "Kaveri Electricals Private Limited",
    "pan": "AAFCK4821M",
    "gstin": make_gstin("27", "AAFCK4821M"),
    "tan": "PNEK09382C",
    "stateCode": "27",
    "address": "Plot 14, Bhosari MIDC, Pune 411026, Maharashtra",
    "email": "accounts@kaverielectricals.in",
    "phone": "+91 20 2712 4480",
    "bank": "HDFC Bank, Bhosari branch, A/c 50200031127745, IFSC HDFC0001782",
    "fyStart": "2026-04-01",
    "asOf": "2026-11-04",
    "prevYearTurnoverPaise": 108_40_00_000_00,
    "owner": "Anil Kaveri",
    "accountantFirm": "Mehta & Associates, Chartered Accountants",
}

# (id, name, city, state, entity, terms days, profile, weight, kind of buyer, contact)
# profile: prompt | steady | slow | chronic
CUSTOMERS = [
    ("C01", "Sharma Traders", "Pune", "27", "firm", 30, "slow", 5, "retail", "Rakesh Sharma"),
    ("C02", "Joshi Electricals", "Nashik", "27", "firm", 30, "steady", 4, "retail", "Mandar Joshi"),
    ("C03", "Deshmukh Contractors", "Pune", "27", "firm", 45, "slow", 5, "project", "Vikas Deshmukh"),
    ("C04", "Kulkarni Builders Pvt Ltd", "Pune", "27", "company", 45, "prompt", 6, "project", "Shruti Kulkarni"),
    ("C05", "Pawar Electric Works", "Satara", "27", "firm", 30, "steady", 3, "retail", "Sachin Pawar"),
    ("C06", "Gaikwad Lighting House", "Kolhapur", "27", "firm", 30, "steady", 3, "lighting", "Neha Gaikwad"),
    ("C07", "Shinde Infra Projects", "Pune", "27", "company", 60, "steady", 5, "project", "Rohit Shinde"),
    ("C08", "Apte Hardware", "Mumbai", "27", "firm", 15, "prompt", 4, "retail", "Madhav Apte"),
    ("C09", "Bhosale Enterprises", "Ahmednagar", "27", "firm", 30, "steady", 3, "retail", "Pradeep Bhosale"),
    ("C10", "Wagh Power Solutions", "Nagpur", "27", "firm", 30, "chronic", 3, "solar", "Amit Wagh"),
    ("C11", "Jadhav & Sons", "Solapur", "27", "firm", 30, "steady", 3, "retail", "Suresh Jadhav"),
    ("C12", "More Electricals", "Chhatrapati Sambhajinagar", "27", "firm", 30, "slow", 3, "retail", "Kiran More"),
    ("C13", "Kale Constructions", "Pimpri", "27", "company", 45, "chronic", 4, "project", "Ganesh Kale"),
    ("C14", "Phadke Home Store", "Pune", "27", "firm", 15, "prompt", 3, "lighting", "Aditi Phadke"),
    ("C15", "Lokhande Industries", "Chakan", "27", "company", 30, "steady", 3, "industrial", "Prakash Lokhande"),
    ("C16", "Hegde Electricals", "Belagavi", "29", "firm", 30, "steady", 3, "retail", "Ramesh Hegde"),
    ("C17", "Shetty Builders", "Bengaluru", "29", "company", 45, "prompt", 4, "project", "Kavya Shetty"),
    ("C18", "Naik Hardware", "Margao", "30", "firm", 30, "steady", 2, "retail", "Joao Naik"),
    ("C19", "Kamat Constructions", "Panaji", "30", "company", 45, "slow", 3, "project", "Siddharth Kamat"),
    ("C20", "Patel Switchgear Mart", "Surat", "24", "firm", 30, "prompt", 4, "switchgear", "Hitesh Patel"),
    ("C21", "Desai Infra", "Vadodara", "24", "company", 45, "steady", 3, "project", "Mehul Desai"),
    ("C22", "Reddy Electricals", "Hyderabad", "36", "firm", 30, "steady", 3, "retail", "Srinivas Reddy"),
    ("C23", "Verma Traders", "Indore", "23", "firm", 30, "slow", 3, "retail", "Anurag Verma"),
    ("C24", "Urban Nest Interiors Pvt Ltd", "Mumbai", "27", "company", 30, "prompt", 11, "lighting", "Ishita Malhotra"),
    ("C25", "Sahyog Infratech Ltd", "Pune", "27", "company", 45, "steady", 12, "project", "Nitin Bapat"),
]

# Customers whose turnover exceeds Rs 10 crore deduct TDS under 194Q on purchases from us
TDS_DEDUCTING_CUSTOMERS = {"C24": "MUMU04417F", "C25": "PNES12093B"}

# (id, name, city, state, entity, gst registered, supply kind, tds section, tds bp, template)
VENDORS = [
    ("V01", "Sahyadri Cables Pvt Ltd", "Pune", "27", "company", True, "goods", "194Q", 10, "A"),
    ("V02", "Narmada Switchgear Ltd", "Ahmedabad", "24", "company", True, "goods", None, 0, "B"),
    ("V03", "Deccan Lighting Co", "Hyderabad", "36", "firm", True, "goods", None, 0, "A"),
    ("V04", "Bharat Fans & Appliances", "New Delhi", "07", "company", True, "goods", None, 0, "B"),
    ("V05", "Konkan Logistics Pvt Ltd", "Pune", "27", "company", True, "service", "194C", 200, "C"),
    ("V06", "Mehta & Associates", "Pune", "27", "firm", True, "professional", "194J", 1000, "C"),
    ("V07", "Shirke Properties", "Pune", "27", "individual", False, "rent", "194I", 1000, "C"),
    ("V08", "Patil Sales Agency", "Pune", "27", "individual", False, "commission", "194H", 200, "C"),
]

# (id, name, hsn, unit, gst rate %, price rupees, category)
SKUS = [
    ("SKU-101", "FR PVC wire 1.0 sq mm, 90 m coil", "8544", "ROL", 18, 1450, "Cables"),
    ("SKU-102", "FR PVC wire 1.5 sq mm, 90 m coil", "8544", "ROL", 18, 2150, "Cables"),
    ("SKU-103", "FR PVC wire 2.5 sq mm, 90 m coil", "8544", "ROL", 18, 3350, "Cables"),
    ("SKU-104", "FR PVC wire 4.0 sq mm, 90 m coil", "8544", "ROL", 18, 5250, "Cables"),
    ("SKU-105", "FR PVC wire 6.0 sq mm, 90 m coil", "8544", "ROL", 18, 7900, "Cables"),
    ("SKU-106", "Armoured cable 4 core 16 sq mm", "8544", "MTR", 18, 410, "Cables"),
    ("SKU-107", "Armoured cable 4 core 25 sq mm", "8544", "MTR", 18, 620, "Cables"),
    ("SKU-108", "LAN cable Cat6, 305 m box", "8544", "BOX", 18, 8900, "Cables"),
    ("SKU-109", "Coaxial cable RG6, 90 m", "8544", "ROL", 18, 2300, "Cables"),
    ("SKU-110", "Flexible cable 3 core 2.5 sq mm", "8544", "MTR", 18, 95, "Cables"),
    ("SKU-201", "MCB single pole 16 A", "8536", "NOS", 18, 185, "Switchgear"),
    ("SKU-202", "MCB double pole 32 A", "8536", "NOS", 18, 620, "Switchgear"),
    ("SKU-203", "RCCB 4 pole 63 A 30 mA", "8536", "NOS", 18, 3850, "Switchgear"),
    ("SKU-204", "MCCB 100 A 3 pole", "8536", "NOS", 18, 6900, "Switchgear"),
    ("SKU-205", "Distribution board 8 way DP", "8537", "NOS", 18, 2450, "Switchgear"),
    ("SKU-206", "Modular switch 6 A", "8536", "NOS", 18, 48, "Switchgear"),
    ("SKU-207", "Modular socket 16 A", "8536", "NOS", 18, 165, "Switchgear"),
    ("SKU-208", "Changeover switch 63 A", "8536", "NOS", 18, 2950, "Switchgear"),
    ("SKU-209", "Isolator 4 pole 63 A", "8536", "NOS", 18, 1150, "Switchgear"),
    ("SKU-210", "Power contactor 32 A", "8536", "NOS", 18, 1850, "Switchgear"),
    ("SKU-301", "LED bulb 9 W", "8539", "NOS", 18, 68, "Lighting"),
    ("SKU-302", "LED batten 20 W", "9405", "NOS", 18, 260, "Lighting"),
    ("SKU-303", "LED panel 2x2 ft 36 W", "9405", "NOS", 18, 1150, "Lighting"),
    ("SKU-304", "LED floodlight 100 W", "9405", "NOS", 18, 2350, "Lighting"),
    ("SKU-305", "LED street light 60 W", "9405", "NOS", 18, 3200, "Lighting"),
    ("SKU-306", "LED downlight 12 W", "9405", "NOS", 18, 290, "Lighting"),
    ("SKU-307", "Solar street light 30 W", "9405", "NOS", 5, 7800, "Solar"),
    ("SKU-308", "Solar inverter 3 kVA", "8504", "NOS", 5, 38500, "Solar"),
    ("SKU-309", "Solar PV module 540 Wp", "8541", "NOS", 5, 14200, "Solar"),
    ("SKU-401", "Ceiling fan 1200 mm", "8414", "NOS", 18, 1850, "Fans"),
    ("SKU-402", "BLDC ceiling fan 1200 mm", "8414", "NOS", 18, 3450, "Fans"),
    ("SKU-403", "Exhaust fan 300 mm", "8414", "NOS", 18, 1250, "Fans"),
    ("SKU-404", "Pedestal fan 400 mm", "8414", "NOS", 18, 2150, "Fans"),
    ("SKU-501", "PVC conduit pipe 25 mm, 3 m", "3917", "PCS", 18, 72, "Conduit"),
    ("SKU-502", "PVC junction box 4 way", "3925", "NOS", 18, 38, "Conduit"),
    ("SKU-503", "Nylon cable ties, pack of 100", "3926", "PAC", 18, 145, "Conduit"),
    ("SKU-504", "PVC insulation tape", "3919", "ROL", 18, 22, "Conduit"),
    ("SKU-601", "Voltage stabiliser 5 kVA", "8504", "NOS", 18, 5600, "Power"),
    ("SKU-602", "Line interactive UPS 1 kVA", "8504", "NOS", 18, 6800, "Power"),
    ("SKU-603", "Tubular battery 150 Ah", "8507", "NOS", 18, 13900, "Power"),
]

# Which SKU categories each buyer type favours, with typical quantity ranges
BUYER_MIX = {
    "retail": [("Cables", (10, 60)), ("Switchgear", (20, 200)), ("Lighting", (20, 150)), ("Fans", (5, 30)), ("Conduit", (50, 400))],
    "project": [("Cables", (20, 120)), ("Switchgear", (10, 80)), ("Lighting", (20, 120)), ("Conduit", (200, 900)), ("Power", (1, 6))],
    "lighting": [("Lighting", (40, 300)), ("Fans", (5, 40)), ("Switchgear", (40, 200))],
    "solar": [("Solar", (2, 12)), ("Cables", (5, 30)), ("Power", (2, 10))],
    "switchgear": [("Switchgear", (20, 160)), ("Cables", (10, 40))],
    "industrial": [("Cables", (10, 60)), ("Switchgear", (5, 40)), ("Power", (1, 8)), ("Lighting", (10, 60))],
}

VENDOR_CATEGORIES = {
    "V01": ["Cables", "Conduit"],
    "V02": ["Switchgear", "Power"],
    "V03": ["Lighting", "Solar"],
    "V04": ["Fans"],
}

EMPLOYEES = [
    ("E01", "Sunil Patwardhan", "Sales manager", 85000),
    ("E02", "Pooja Ranade", "Accounts executive", 42000),
    ("E03", "Imran Shaikh", "Sales executive", 38000),
    ("E04", "Swati Gokhale", "Sales executive", 36000),
    ("E05", "Ravi Kamble", "Store-in-charge", 34000),
    ("E06", "Mahesh Thorat", "Delivery driver", 22000),
    ("E07", "Dattatray Salunkhe", "Delivery driver", 21000),
    ("E08", "Ajay Mane", "Warehouse assistant", 18500),
    ("E09", "Santosh Kadam", "Warehouse assistant", 18000),
    ("E10", "Meena Pawar", "Office assistant", 20000),
    ("E11", "Rahul Inamdar", "Field technician", 28000),
    ("E12", "Farhan Qureshi", "Purchase executive", 40000),
    ("E13", "Leena Dsouza", "Customer service", 26000),
    ("E14", "Omkar Bhide", "Marketing executive", 35000),
]
