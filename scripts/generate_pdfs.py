#!/usr/bin/env python3
"""Generate sample PDF files for the MES AI Assistant knowledge base."""

import os
from fpdf import FPDF

FONT_PATH = "C:/Windows/Fonts/simhei.ttf"
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "pdfs")

os.makedirs(OUTPUT_DIR, exist_ok=True)


class MesPDF(FPDF):
    def __init__(self, title):
        super().__init__()
        self.doc_title = title
        self.add_font("SimHei", "", FONT_PATH)
        self.add_font("SimHei", "B", FONT_PATH)
        self.set_auto_page_break(auto=True, margin=25)
        self.set_margins(15, 15, 15)

    def header(self):
        if self.page_no() == 1:
            return
        self.set_font("SimHei", "", 8)
        self.set_text_color(150, 150, 150)
        self.cell(0, 8, self.doc_title, align="L")
        self.ln(5)
        self.set_draw_color(200, 200, 200)
        self.line(15, 18, 195, 18)
        self.ln(5)

    def footer(self):
        self.set_y(-15)
        self.set_font("SimHei", "", 8)
        self.set_text_color(150, 150, 150)
        self.cell(0, 10, f"- {self.page_no()} -", align="C")

    def add_title_block(self, title, subtitle=""):
        self.ln(10)
        self.set_font("SimHei", "B", 18)
        self.set_text_color(30, 30, 30)
        self.cell(0, 12, title, align="C", new_x="LMARGIN", new_y="NEXT")
        if subtitle:
            self.ln(2)
            self.set_font("SimHei", "", 10)
            self.set_text_color(100, 100, 100)
            self.cell(0, 7, subtitle, align="C", new_x="LMARGIN", new_y="NEXT")
        self.ln(3)
        self.set_draw_color(77, 107, 254)
        self.set_line_width(0.8)
        self.line(15, self.get_y(), 195, self.get_y())
        self.ln(6)

    def add_heading(self, text, level=1):
        self.ln(3)
        if level == 1:
            self.set_font("SimHei", "B", 14)
            self.set_text_color(77, 107, 254)
        elif level == 2:
            self.set_font("SimHei", "B", 12)
            self.set_text_color(50, 50, 50)
        else:
            self.set_font("SimHei", "B", 11)
            self.set_text_color(80, 80, 80)
        self.cell(0, 8, text, new_x="LMARGIN", new_y="NEXT")
        self.ln(2)

    def add_body(self, text, indent=False):
        self.set_font("SimHei", "", 10)
        self.set_text_color(50, 50, 50)
        if indent:
            self.set_x(20)
        self.multi_cell(0, 6.5, text)
        self.ln(1.5)

    def add_kv(self, key, value):
        self.set_font("SimHei", "B", 10)
        self.set_text_color(80, 80, 80)
        self.set_x(20)
        self.cell(45, 6.5, f"{key}: ")
        self.set_font("SimHei", "", 10)
        self.set_text_color(50, 50, 50)
        self.cell(0, 6.5, value, new_x="LMARGIN", new_y="NEXT")
        self.ln(1)


def generate_maintenance_manual():
    pdf = MesPDF("设备预防性维护手册")
    pdf.add_page()
    pdf.add_title_block(
        "设备预防性维护手册",
        "编制部门：设备工程部  |  版本：V2.0  |  生效日期：2025-04-10"
    )

    pdf.add_heading("第一章 总则", 1)
    pdf.add_body("1.1 目的：本手册旨在建立全厂设备预防性维护（PM）标准体系，通过定期点检、状态监测和计划性维护，降低设备故障率，提升设备综合效率（OEE）。")
    pdf.add_body("1.2 适用范围：适用于全厂所有生产设备，包括CNC加工中心、注塑机、烧结炉、涂装线等。")
    pdf.add_body("1.3 维护策略：采用日常点检+定期维护+状态监测三级维护体系，结合TPM全员生产维护理念。")
    pdf.add_body("1.4 维护等级定义：")
    pdf.add_kv("日常点检", "操作员每日开工前执行，5-10分钟")
    pdf.add_kv("周维护", "维修工程师每周执行，30-60分钟")
    pdf.add_kv("月度维护", "维修工程师每月执行，2-4小时")
    pdf.add_kv("年度大修", "每年安排3-5天全面检修")

    pdf.add_page()
    pdf.add_heading("第二章 CNC加工中心维护标准", 1)
    pdf.add_heading("2.1 主轴轴承", 2)
    pdf.add_body("每日检查振动值（标准 <= 2.0mm/s），每月检测频谱特征，每8000小时或2年更换轴承（以先到为准）。", indent=True)
    pdf.add_body("振动监测仪器：推荐使用SKF CMSS 2200或同等精度测振仪。测点布置在主轴前端和后端轴承座处。", indent=True)
    pdf.add_body("更换标准：振动值持续超过3.5mm/s，或频谱分析出现BPFI/BPFO特征频率峰值时，应安排更换。", indent=True)

    pdf.add_heading("2.2 主轴润滑", 2)
    pdf.add_body("每日检查润滑系统压力和流量，每周补充主轴专用润滑油（ISO VG32），每6个月更换全部润滑油。", indent=True)
    pdf.add_kv("润滑油型号", "ISO VG32 主轴专用润滑油")
    pdf.add_kv("压力标准", "0.3-0.5 MPa")
    pdf.add_kv("流量标准", "0.5-1.0 L/min")

    pdf.add_heading("2.3 导轨与丝杠", 2)
    pdf.add_body("每日检查润滑状态和运行声音，每季度检测直线度精度（标准 <= 0.01mm/500mm），每年清洗导轨并重新涂抹润滑脂。", indent=True)

    pdf.add_heading("2.4 冷却系统", 2)
    pdf.add_body("每日检查冷却液液位和浓度，每周检测冷却液pH值（标准8.5-9.5），每季度更换冷却液并清洗管路。", indent=True)

    pdf.add_heading("2.5 电气系统", 2)
    pdf.add_body("每日检查PLC报警日志，每月检查电气柜温度和散热系统，每半年检查接线端子紧固状态。", indent=True)

    pdf.add_page()
    pdf.add_heading("第三章 振动监测与诊断", 1)
    pdf.add_heading("3.1 振动监测标准", 2)
    pdf.add_body("设备振动速度值分为四个等级：")
    pdf.add_kv("正常", "<= 2.0 mm/s - 设备运行正常，继续日常监控")
    pdf.add_kv("关注", "2.0 - 3.5 mm/s - 需增加监测频次，安排专业诊断")
    pdf.add_kv("警告", "3.5 - 7.1 mm/s - 需在72小时内安排检修")
    pdf.add_kv("危险", "> 7.1 mm/s - 立即停机，禁止运行")

    pdf.add_heading("3.2 频谱分析要点", 2)
    pdf.add_body("1X频率分量突出：指示转子不平衡。不平衡量越大，1X分量幅值越高。", indent=True)
    pdf.add_body("2X频率分量突出：指示对中偏差。常与1X分量同时出现。", indent=True)
    pdf.add_body("高频分量（>1kHz）：指示轴承故障。需进一步进行包络分析确认。", indent=True)
    pdf.add_body("啮合频率及其谐波：指示齿轮问题。齿轮磨损时会出现边频带。", indent=True)

    pdf.add_heading("3.3 轴承故障频率", 2)
    pdf.add_body("内圈故障频率（BPFI）= n/2 x (1 + d/D x cos a) x RPM/60")
    pdf.add_body("外圈故障频率（BPFO）= n/2 x (1 - d/D x cos a) x RPM/60")
    pdf.add_body("以7014C轴承为例（n=14, d=8.74mm, D=70mm, a=15度）：在6000RPM时，BPFI=148Hz, BPFO=92Hz")
    pdf.add_body("当频谱中出现对应故障频率峰值时，需及时安排轴承更换。建议结合趋势分析判断故障发展阶段。", indent=True)

    pdf.add_heading("3.4 在线监测系统", 2)
    pdf.add_body("建议配置在线振动监测系统，对关键设备实现实时监控和自动报警，结合趋势分析实现预测性维护。")
    pdf.add_body("推荐配置：每台关键设备安装2-3个永久性振动传感器，数据采集间隔 <= 5分钟，异常自动推送报警。", indent=True)

    pdf.add_page()
    pdf.add_heading("第四章 注塑机维护标准", 1)
    pdf.add_heading("4.1 螺杆与料筒", 2)
    pdf.add_body("每日检查螺杆转动声音和温度分布，每月检测螺杆磨损量（标准 <= 0.05mm），每2年或50万模次更换螺杆头。", indent=True)
    pdf.add_heading("4.2 液压系统", 2)
    pdf.add_body("每日检查液压油位和压力，每周检测油温（标准 <= 55度），每半年检测油液清洁度（NAS 9级），每年更换液压油。", indent=True)
    pdf.add_heading("4.3 模具", 2)
    pdf.add_body("每日检查模具温度和冷却水流量，每周检查模具型腔磨损状态，每5000模次进行模具保养。", indent=True)

    pdf.add_page()
    pdf.add_heading("第五章 维护计划与记录管理", 1)
    pdf.add_heading("5.1 日点检", 2)
    pdf.add_body("操作员每日开工前按点检表执行，包括外观、声音、温度、压力等基础项目。点检结果记录在MES设备管理模块中。", indent=True)
    pdf.add_heading("5.2 周维护", 2)
    pdf.add_body("维修工程师每周执行，包括润滑补充、紧固检查、过滤器清洁等。维护完成后需填写周维护记录表。", indent=True)
    pdf.add_heading("5.3 月度维护", 2)
    pdf.add_body("包括精度检测、振动分析、油液检测等深度检查项目。月度维护报告需提交设备主管审核。", indent=True)
    pdf.add_heading("5.4 年度大修", 2)
    pdf.add_body("每年安排3-5天年度大修，包括全面拆检、精度恢复、易损件批量更换。大修计划需提前3个月制定。", indent=True)
    pdf.add_heading("5.5 记录管理", 2)
    pdf.add_body("所有维护活动必须记录在MES设备管理模块中，包括维护内容、更换备件、维护人员和验收结果。记录保存期限 >= 3年。", indent=True)

    filepath = os.path.join(OUTPUT_DIR, "maintenance-manual.pdf")
    pdf.output(filepath)
    print(f"Generated: {filepath} ({pdf.page_no()} pages)")


def generate_bearing_diagnosis_spec():
    pdf = MesPDF("轴承故障诊断技术规范")
    pdf.add_page()
    pdf.add_title_block(
        "轴承故障诊断技术规范",
        "编制部门：设备工程部  |  版本：V1.0  |  生效日期：2025-05-18"
    )

    pdf.add_heading("1. 范围与引用标准", 1)
    pdf.add_body("1.1 本规范规定了滚动轴承振动诊断的技术要求、诊断流程和判定标准。适用于角接触球轴承、深沟球轴承、圆柱滚子轴承等常见类型。")
    pdf.add_body("1.2 适用设备：CNC加工中心主轴、注塑机液压泵电机、烧结炉风机等关键设备的滚动轴承。")
    pdf.add_body("1.3 引用标准：")
    pdf.add_kv("ISO 10816", "机械振动评估标准")
    pdf.add_kv("ISO 15242", "滚动轴承振动测量方法")
    pdf.add_kv("GB/T 24607", "滚动轴承寿命与可靠性")

    pdf.add_page()
    pdf.add_heading("2. 轴承故障频率计算", 1)
    pdf.add_body("2.1 轴承故障特征频率是诊断轴承故障的核心依据。不同故障类型对应不同的特征频率。")

    pdf.add_heading("2.2 故障频率计算公式", 2)
    pdf.add_body("内圈故障频率（BPFI）= n/2 x (1 + d/D x cos a) x f_r", indent=True)
    pdf.add_body("外圈故障频率（BPFO）= n/2 x (1 - d/D x cos a) x f_r", indent=True)
    pdf.add_body("滚动体故障频率（BSF）= D/(2d) x (1 - (d/D x cos a)^2) x f_r", indent=True)
    pdf.add_body("保持架故障频率（FTF）= 1/2 x (1 - d/D x cos a) x f_r", indent=True)

    pdf.add_heading("2.3 参数说明", 2)
    pdf.add_kv("n", "滚珠数量")
    pdf.add_kv("d", "滚珠直径 (mm)")
    pdf.add_kv("D", "节圆直径 (mm)")
    pdf.add_kv("a", "接触角 (度)")
    pdf.add_kv("f_r", "转频 = RPM/60 (Hz)")

    pdf.add_heading("2.4 常见轴承计算示例", 2)
    pdf.add_body("以7014C轴承为例（n=14, d=8.74mm, D=70mm, a=15度）：")
    pdf.add_kv("转速 6000 RPM", "BPFI=148Hz, BPFO=92Hz, BSF=63Hz, FTF=20Hz")
    pdf.add_kv("转速 3000 RPM", "BPFI=74Hz, BPFO=46Hz, BSF=32Hz, FTF=10Hz")

    pdf.add_page()
    pdf.add_heading("3. 故障发展四阶段", 1)
    pdf.add_body("轴承故障的发展是一个渐进过程，通过振动监测可以提前预警。根据振动特征变化，将故障发展分为四个阶段：")

    pdf.add_heading("第一阶段（初期磨损）", 2)
    pdf.add_body("超声频段（20-40kHz）出现异常，常规频谱无明显变化。此时轴承寿命剩余约10%-20%。", indent=True)
    pdf.add_body("检测方法：超声检测仪或冲击脉冲仪。此阶段常规振动检测难以发现。", indent=True)
    pdf.add_body("建议措施：增加监测频次，记录基线数据。", indent=True)

    pdf.add_heading("第二阶段（早期疲劳）", 2)
    pdf.add_body("高频段（1-10kHz）出现轴承故障特征频率，振动总值略有上升（约10%-20%）。此时轴承寿命剩余约5%-10%。", indent=True)
    pdf.add_body("检测方法：高频振动检测 + 包络分析。频谱中可见BPFI/BPFO峰值。", indent=True)
    pdf.add_body("建议措施：订购备件，制定更换计划（1-2个月内）。", indent=True)

    pdf.add_heading("第三阶段（中期扩展）", 2)
    pdf.add_body("故障频率及其谐波在频谱中明显可见，振动总值显著上升（超过报警阈值），伴随温度升高（+5-10度）。", indent=True)
    pdf.add_body("检测方法：常规振动检测即可发现。频谱中出现多个故障频率谐波。", indent=True)
    pdf.add_body("建议措施：立即安排停机更换（72小时内）。", indent=True)

    pdf.add_heading("第四阶段（晚期失效）", 2)
    pdf.add_body("振动值急剧增大，频谱出现宽带噪声，设备可能随时停机。必须立即停机更换。", indent=True)
    pdf.add_body("检测方法：振动值严重超标，可能伴随异响。", indent=True)
    pdf.add_body("建议措施：立即停机，禁止运行！紧急更换轴承。", indent=True)

    pdf.add_page()
    pdf.add_heading("4. 诊断流程", 1)
    pdf.add_body("4.1 信息收集：记录设备型号、轴承型号、转速、运行工况等基础信息。")
    pdf.add_body("4.2 振动测量：在规定测点进行振动速度和加速度测量，记录时域波形。")
    pdf.add_body("4.3 频谱分析：进行FFT频谱分析，识别主要频率分量。")
    pdf.add_body("4.4 包络分析：对高频信号进行包络解调，提取轴承故障特征频率。")
    pdf.add_body("4.5 对比判定：将分析结果与故障频率计算值对比，判定故障类型和严重程度。")
    pdf.add_body("4.6 趋势分析：对比历史数据，判断故障发展趋势和剩余寿命。")
    pdf.add_body("4.7 诊断报告：出具诊断报告，包括测量数据、分析结果、判定结论和维护建议。")

    pdf.add_heading("4.8 测点布置要求", 2)
    pdf.add_body("测点应布置在轴承载荷区附近，通常选择轴承座上方或侧面。测点表面应清洁平整，确保传感器良好耦合。", indent=True)
    pdf.add_body("每台设备至少设置2个测点（驱动端和非驱动端），关键设备建议设置3-4个测点。", indent=True)

    filepath = os.path.join(OUTPUT_DIR, "bearing-diagnosis.pdf")
    pdf.output(filepath)
    print(f"Generated: {filepath} ({pdf.page_no()} pages)")


if __name__ == "__main__":
    generate_maintenance_manual()
    generate_bearing_diagnosis_spec()
    print("\nAll PDF files generated successfully!")
