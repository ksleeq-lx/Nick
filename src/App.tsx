import React, { useState, useEffect, useMemo } from 'react';
import defaultMasterData from './data/ds05_product_assumption_master.json';
import './App.css';

interface Product {
  product_id: string;
  product_name: string;
  application: string;
  market: '내수' | '수출';
  currency: 'KRW' | 'USD';
  list_price: number;
  var_cost_per_kg: number;
  fixed_cost_month: number | null;
  base_volume_ton: number;
  capacity_ton: number;
  target_op_margin_pct: number;
  remark?: string;
}

interface ScenarioMeta {
  scenario_id: string;
  scenario_name: string;
  volume_delta_pct: number;
  price_delta_pct: number;
  var_cost_delta_pct: number;
}

interface MasterData {
  meta: {
    version: string;
    base_date: string;
    seed: number;
    default_fx_krw_per_usd: number;
    period_unit: string;
    note: string;
    scenarios: ScenarioMeta[];
  };
  products: Product[];
}

interface ScenarioInput {
  volume_delta_pct: number;
  price_delta_pct: number;
  var_cost_delta_pct: number;
}

interface ComputedResult {
  scenario_id: string;
  scenario_name: string;
  dv: number;
  dp: number;
  dc: number;
  V_s: number;
  Q_s: number;
  P_s: number;
  C_s: number;
  revenue: number;
  varCost: number;
  contrib: number;
  fixedCost: number | null;
  opProfit: number | null;
  opMargin: number | null;
  marginState: string;
  bep: number | null;
  bepState: string;
  capState: string;
  capExcess: number;
  hasFixedCost: boolean;
  isUcmError: boolean;
}

interface SensitivityItem {
  axis: string;
  delta: number;
  impact: number;
  weight: number;
}

interface SensitivityResult {
  scenario_id: string;
  scenario_name: string;
  items: SensitivityItem[];
  totalDiff: number;
  crossEffect: number;
  hasFixedCost: boolean;
}

interface HistoryItem {
  id: number;
  time: string;
  productId: string;
  productName: string;
  fxRate: number;
  scenariosInput: {
    UP: ScenarioInput;
    DOWN: ScenarioInput;
  };
  resultsSummary: {
    id: string;
    opProfit: number | null;
    margin: number | null;
    bep: number | null;
  }[];
}

// --- 유틸리티 함수 ---
const formatNumber = (val: number | null | undefined, decimals = 0): string => {
  if (val === null || val === undefined || isNaN(val)) return '—';
  return Number(val).toLocaleString('ko-KR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
};

const halfUpRound = (val: number, decimals = 0): number => {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor + (val >= 0 ? 0.5 : -0.5)) / factor;
};

export default function App() {
  // --- 상태 관리 ---
  const [masterData, setMasterData] = useState<MasterData>(defaultMasterData as MasterData);
  const [selectedProductId, setSelectedProductId] = useState<string>('P-01');
  const [fxRate, setFxRate] = useState<number>(defaultMasterData.meta.default_fx_krw_per_usd || 1350);

  // 시나리오별 변동률 상태 (BASE는 고정 0)
  const [scenariosInput, setScenariosInput] = useState<{ UP: ScenarioInput; DOWN: ScenarioInput }>({
    UP: { volume_delta_pct: 10, price_delta_pct: 5, var_cost_delta_pct: -3 },
    DOWN: { volume_delta_pct: -10, price_delta_pct: -5, var_cost_delta_pct: 3 },
  });

  // 활성 탭 (S-01: 손익비교, S-02: 변수별영향, S-03: 가정이력, S-04: 마스터반입)
  const [activeTab, setActiveTab] = useState<string>('S-01');
  const [historyList, setHistoryList] = useState<HistoryItem[]>([]);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // LocalStorage 이력 복원
  useEffect(() => {
    try {
      const saved = localStorage.getItem('exs05.scenarios.v1');
      if (saved) setHistoryList(JSON.parse(saved));
    } catch (e) {
      console.error('LocalStorage load error:', e);
    }
  }, []);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  // 선택된 제품 정보
  const currentProduct = useMemo(() => {
    return masterData.products.find((p) => p.product_id === selectedProductId) || masterData.products[0];
  }, [masterData, selectedProductId]);

  // 입력값 검증 (FX 및 변동률 범위)
  const validationErrors = useMemo(() => {
    const errors: Record<string, string> = {};
    if (currentProduct?.market === '수출' && (fxRate <= 0 || isNaN(fxRate))) {
      errors.fx = '환율은 0보다 커야 합니다.';
    }
    (['UP', 'DOWN'] as const).forEach((sId) => {
      const s = scenariosInput[sId];
      if (s.volume_delta_pct < -50 || s.volume_delta_pct > 50) {
        errors[`${sId}_v`] = '판매량 변동률은 -50% ~ 50% 사이여야 합니다.';
      }
      if (s.price_delta_pct < -30 || s.price_delta_pct > 30) {
        errors[`${sId}_p`] = '단가 변동률은 -30% ~ 30% 사이여야 합니다.';
      }
      if (s.var_cost_delta_pct < -30 || s.var_cost_delta_pct > 30) {
        errors[`${sId}_c`] = '변동비 변동률은 -30% ~ 30% 사이여야 합니다.';
      }
    });
    return errors;
  }, [currentProduct, fxRate, scenariosInput]);

  const isInputValid = Object.keys(validationErrors).length === 0;

  // --- 핵심 손익 산출 로직 (5.2 ~ 5.7) ---
  const computedResults = useMemo<ComputedResult[] | null>(() => {
    if (!currentProduct || !isInputValid) return null;

    const scenarios = [
      { id: 'BASE', name: '기준안', dv: 0, dp: 0, dc: 0 },
      { id: 'UP', name: '상향안', dv: scenariosInput.UP.volume_delta_pct, dp: scenariosInput.UP.price_delta_pct, dc: scenariosInput.UP.var_cost_delta_pct },
      { id: 'DOWN', name: '하향안', dv: scenariosInput.DOWN.volume_delta_pct, dp: scenariosInput.DOWN.price_delta_pct, dc: scenariosInput.DOWN.var_cost_delta_pct },
    ];

    const { base_volume_ton: V0, list_price: P, var_cost_per_kg: C0, fixed_cost_month: F, capacity_ton: CAP, target_op_margin_pct: T, market } = currentProduct;

    return scenarios.map((scen) => {
      const dv = scen.dv;
      const dp = scen.dp;
      const dc = scen.dc;

      // 5.2 가정값 환산
      const V_s = V0 * (1 + dv / 100);
      const Q_s = V_s * 1000;
      const P_s = market === '내수' ? P * (1 + dp / 100) : P * fxRate * (1 + dp / 100);
      const C_s = C0 * (1 + dc / 100);

      // 5.3 금액 산출 (반올림 오차 방지를 위한 표기값 연동 구조 적용)
      const rawRevenue = Q_s * P_s;
      const rawVarCost = Q_s * C_s;
      const rawContrib = rawRevenue - rawVarCost;
      const hasFixedCost = F !== null && F !== undefined;
      const rawOpProfit = hasFixedCost ? rawContrib - F : null;

      const revDisp = halfUpRound(rawRevenue);
      const varCostDisp = halfUpRound(rawVarCost);
      const contribDisp = revDisp - varCostDisp; // 차액 재산출로 오차 0 보장
      const fixedDisp = hasFixedCost ? halfUpRound(F) : null;
      const opDisp = hasFixedCost ? contribDisp - (fixedDisp || 0) : null;

      // 5.4 단위 공헌이익 (UCM)
      const ucm = P_s - C_s;
      const isUcmError = ucm <= 0;

      // 5.5 영업이익률 및 목표 판정
      let opMargin: number | null = null;
      let marginState = '—';
      if (rawRevenue > 0 && rawOpProfit !== null) {
        opMargin = (rawOpProfit / rawRevenue) * 100;
        marginState = opMargin >= T ? '정상' : '목표 미달';
      }

      // 5.6 BEP 산출
      let bep: number | null = null;
      let bepState = '—';
      if (hasFixedCost && !isUcmError && ucm > 0 && F !== null) {
        bep = F / ucm / 1000; // 톤 단위
        bepState = bep <= CAP ? '정상' : 'BEP 달성 불가';
      }

      // 5.7 생산능력 판정
      const capState = V_s <= CAP ? '정상' : '생산능력 초과';
      const capExcess = V_s - CAP;

      return {
        scenario_id: scen.id,
        scenario_name: scen.name,
        dv, dp, dc,
        V_s, Q_s, P_s, C_s,
        revenue: revDisp,
        varCost: varCostDisp,
        contrib: contribDisp,
        fixedCost: fixedDisp,
        opProfit: opDisp,
        opMargin,
        marginState,
        bep,
        bepState,
        capState,
        capExcess,
        hasFixedCost,
        isUcmError,
      };
    });
  }, [currentProduct, fxRate, scenariosInput, isInputValid]);

  // --- 5.8 변수별 영향 산출 (상향/하향안 각각 1축씩 변경 시 영업이익 증감) ---
  const sensitivityAnalysis = useMemo<SensitivityResult[] | null>(() => {
    if (!computedResults || !currentProduct) return null;
    const baseResult = computedResults.find(r => r.scenario_id === 'BASE');
    if (!baseResult) return null;

    const { base_volume_ton: V0, list_price: P, var_cost_per_kg: C0, fixed_cost_month: F, market } = currentProduct;
    const hasFixedCost = F !== null && F !== undefined;
    const baseOp = hasFixedCost ? (baseResult.opProfit ?? 0) : baseResult.contrib;

    const calcSingleAxisOP = (dv: number, dp: number, dc: number) => {
      const V_s = V0 * (1 + dv / 100);
      const Q_s = V_s * 1000;
      const P_s = market === '내수' ? P * (1 + dp / 100) : P * fxRate * (1 + dp / 100);
      const C_s = C0 * (1 + dc / 100);
      const rev = Q_s * P_s;
      const vc = Q_s * C_s;
      const contrib = rev - vc;
      return hasFixedCost && F !== null ? contrib - F : contrib;
    };

    return (['UP', 'DOWN'] as const).map((sId) => {
      const input = scenariosInput[sId];
      // 판매량만 변경
      const opV = calcSingleAxisOP(input.volume_delta_pct, 0, 0);
      // 단가만 변경
      const opP = calcSingleAxisOP(0, input.price_delta_pct, 0);
      // 변동비만 변경
      const opC = calcSingleAxisOP(0, 0, input.var_cost_delta_pct);

      const diffV = opV - baseOp;
      const diffP = opP - baseOp;
      const diffC = opC - baseOp;

      const sumAbs = Math.abs(diffV) + Math.abs(diffP) + Math.abs(diffC);

      const items: SensitivityItem[] = [
        { axis: '판매량', delta: input.volume_delta_pct, impact: diffV, weight: sumAbs > 0 ? (Math.abs(diffV) / sumAbs) * 100 : 0 },
        { axis: '단가', delta: input.price_delta_pct, impact: diffP, weight: sumAbs > 0 ? (Math.abs(diffP) / sumAbs) * 100 : 0 },
        { axis: '변동비', delta: input.var_cost_delta_pct, impact: diffC, weight: sumAbs > 0 ? (Math.abs(diffC) / sumAbs) * 100 : 0 },
      ];

      const targetResult = computedResults.find(r => r.scenario_id === sId);
      const targetOp = targetResult?.opProfit !== null && targetResult?.opProfit !== undefined ? targetResult.opProfit : (targetResult?.contrib ?? 0);
      const totalDiff = targetOp - baseOp;
      const crossEffect = totalDiff - (diffV + diffP + diffC);

      return {
        scenario_id: sId,
        scenario_name: sId === 'UP' ? '상향안' : '하향안',
        items,
        totalDiff,
        crossEffect,
        hasFixedCost,
      };
    });
  }, [computedResults, currentProduct, fxRate, scenariosInput]);

  // --- F-07 클립보드 복사 ---
  const handleCopyClipboard = () => {
    if (!computedResults) return;
    let text = `[제품 손익 비교 결과: ${currentProduct.product_name} (${currentProduct.product_id})]\n`;
    text += `구분\t기준안\t상향안\t하향안\n`;
    text += `판매량(t)\t${computedResults.map(r => formatNumber(r.V_s, 1)).join('\t')}\n`;
    text += `매출액(KRW)\t${computedResults.map(r => formatNumber(r.revenue)).join('\t')}\n`;
    text += `영업이익(KRW)\t${computedResults.map(r => formatNumber(r.opProfit)).join('\t')}\n`;
    text += `영업이익률(%)\t${computedResults.map(r => r.opMargin !== null ? r.opMargin.toFixed(2) + '%' : '—').join('\t')}\n`;
    text += `BEP(t)\t${computedResults.map(r => formatNumber(r.bep, 1)).join('\t')}\n`;

    navigator.clipboard.writeText(text).then(() => {
      showToast('클립보드에 3안 대비표가 복사되었습니다.');
    });
  };

  // --- F-08 가정 세트 저장 ---
  const handleSaveScenarioSet = () => {
    try {
      if (!computedResults) return;
      const newItem: HistoryItem = {
        id: Date.now(),
        time: new Date().toLocaleString(),
        productId: currentProduct.product_id,
        productName: currentProduct.product_name,
        fxRate,
        scenariosInput,
        resultsSummary: computedResults.map(r => ({
          id: r.scenario_id,
          opProfit: r.opProfit,
          margin: r.opMargin,
          bep: r.bep,
        })),
      };
      const updated = [newItem, ...historyList].slice(0, 100);
      setHistoryList(updated);
      localStorage.setItem('exs05.scenarios.v1', JSON.stringify(updated));
      showToast('현재 가정 세트가 LocalStorage에 저장되었습니다.');
    } catch (e) {
      showToast('저장 실패 (용량 초과 또는 접근 제한)');
    }
  };

  const handleRestoreHistory = (item: HistoryItem) => {
    setSelectedProductId(item.productId);
    setFxRate(item.fxRate);
    setScenariosInput(item.scenariosInput);
    setActiveTab('S-01');
    showToast('저장된 가정 세트를 불러왔습니다.');
  };

  const handleDeleteHistory = (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    const updated = historyList.filter(item => item.id !== id);
    setHistoryList(updated);
    localStorage.setItem('exs05.scenarios.v1', JSON.stringify(updated));
    showToast('이력이 삭제되었습니다.');
  };

  // --- F-01 파일 업로드 핸들러 (CSV / JSON) ---
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const content = event.target?.result as string;
        if (file.name.endsWith('.json')) {
          const parsed = JSON.parse(content);
          if (parsed.products && Array.isArray(parsed.products)) {
            setMasterData(parsed);
            showToast('JSON 마스터 반입 완료');
          } else {
            alert('유효하지 않은 JSON 마스터 구조입니다.');
          }
        } else {
          // CSV 파싱 간단 구현
          const lines = content.split('\n').filter(l => l.trim() !== '');
          if (lines.length < 2) {
            alert('CSV 행 수가 부족합니다.');
            return;
          }
          const headers = lines[0].split(',').map(h => h.trim());
          const newProducts: Product[] = [];
          for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',').map(c => c.trim());
            if (cols.length < headers.length) continue;
            newProducts.push({
              product_id: cols[0] || `P-0${i}`,
              product_name: cols[1] || `제품 ${i}`,
              application: cols[2] || '일반 용도',
              market: (cols[3] === '수출' ? '수출' : '내수') as '내수' | '수출',
              currency: (cols[4] === 'USD' ? 'USD' : 'KRW') as 'KRW' | 'USD',
              list_price: parseFloat(cols[5]) || 1000,
              var_cost_per_kg: parseFloat(cols[6]) || 500,
              fixed_cost_month: cols[7] === '' || cols[7] === '—' || cols[7].toLowerCase() === 'null' ? null : parseFloat(cols[7]),
              base_volume_ton: parseFloat(cols[8]) || 1000,
              capacity_ton: parseFloat(cols[9]) || 1500,
              target_op_margin_pct: parseFloat(cols[10]) || 10.0,
              remark: cols[11] || '',
            });
          }
          if (newProducts.length > 0) {
            setMasterData(prev => ({
              ...prev,
              products: newProducts,
            }));
            setSelectedProductId(newProducts[0].product_id);
            showToast(`CSV 반입 성공 (${newProducts.length}개 제품)`);
          }
        }
      } catch (err: any) {
        alert('파일 파싱 중 오류 발생: ' + err.message);
      }
    };
    reader.readAsText(file, 'UTF-8');
  };

  return (
    <div className="app-container">
      {toastMessage && <div className="toast-banner">{toastMessage}</div>}

      {/* 헤더 영역 */}
      <header className="app-header">
        <div className="header-title">
          <h1>제품별 손익 가정 비교기</h1>
          <span className="version-badge">{masterData.meta.version}</span>
        </div>
        <div className="header-nav">
          <button className={activeTab === 'S-01' ? 'active' : ''} onClick={() => setActiveTab('S-01')}>손익 비교</button>
          <button className={activeTab === 'S-02' ? 'active' : ''} onClick={() => setActiveTab('S-02')}>변수별 영향</button>
          <button className={activeTab === 'S-03' ? 'active' : ''} onClick={() => setActiveTab('S-03')}>가정 이력 ({historyList.length})</button>
          <button className={activeTab === 'S-04' ? 'active' : ''} onClick={() => setActiveTab('S-04')}>마스터 반입</button>
        </div>
      </header>

      {/* 메인 컨텐츠 영역 */}
      <main className="main-content">
        {/* S-01 & S-02 공통 조건 패널 (제품 선택 및 변동률 입력) */}
        {activeTab !== 'S-03' && activeTab !== 'S-04' && (
          <section className="control-panel">
            <div className="panel-row">
              <div className="form-group">
                <label>제품 선택</label>
                <select
                  value={selectedProductId}
                  onChange={(e) => setSelectedProductId(e.target.value)}
                >
                  {masterData.products.map((p) => (
                    <option key={p.product_id} value={p.product_id}>
                      [{p.product_id}] {p.product_name} ({p.market})
                    </option>
                  ))}
                </select>
              </div>

              <div className="product-info-badges">
                <span className={`badge market-${currentProduct.market}`}>
                  {currentProduct.market} ({currentProduct.currency})
                </span>
                <span className="badge-sub">용도: {currentProduct.application}</span>
                <span className="badge-sub">기준 판매량: {formatNumber(currentProduct.base_volume_ton, 1)} t</span>
                <span className="badge-sub">생산능력: {formatNumber(currentProduct.capacity_ton, 1)} t</span>
                <span className="badge-sub">목표 이익률: {currentProduct.target_op_margin_pct}%</span>
              </div>
            </div>

            <div className="panel-row variables-row">
              <div className="form-group fx-group">
                <label>환율 (KRW/USD)</label>
                <input
                  type="number"
                  value={fxRate}
                  disabled={currentProduct.market === '내수'}
                  onChange={(e) => setFxRate(parseFloat(e.target.value) || 0)}
                />
                {validationErrors.fx && <span className="error-text">{validationErrors.fx}</span>}
              </div>

              {/* 상향안 입력 */}
              <div className="scenario-input-box">
                <h4>상향안 변동률 (%)</h4>
                <div className="inputs-grid">
                  <div>
                    <label>판매량</label>
                    <input
                      type="number"
                      step="0.1"
                      value={scenariosInput.UP.volume_delta_pct}
                      onChange={(e) => setScenariosInput({
                        ...scenariosInput,
                        UP: { ...scenariosInput.UP, volume_delta_pct: parseFloat(e.target.value) || 0 }
                      })}
                    />
                  </div>
                  <div>
                    <label>단가</label>
                    <input
                      type="number"
                      step="0.1"
                      value={scenariosInput.UP.price_delta_pct}
                      onChange={(e) => setScenariosInput({
                        ...scenariosInput,
                        UP: { ...scenariosInput.UP, price_delta_pct: parseFloat(e.target.value) || 0 }
                      })}
                    />
                  </div>
                  <div>
                    <label>변동비</label>
                    <input
                      type="number"
                      step="0.1"
                      value={scenariosInput.UP.var_cost_delta_pct}
                      onChange={(e) => setScenariosInput({
                        ...scenariosInput,
                        UP: { ...scenariosInput.UP, var_cost_delta_pct: parseFloat(e.target.value) || 0 }
                      })}
                    />
                  </div>
                </div>
              </div>

              {/* 하향안 입력 */}
              <div className="scenario-input-box">
                <h4>하향안 변동률 (%)</h4>
                <div className="inputs-grid">
                  <div>
                    <label>판매량</label>
                    <input
                      type="number"
                      step="0.1"
                      value={scenariosInput.DOWN.volume_delta_pct}
                      onChange={(e) => setScenariosInput({
                        ...scenariosInput,
                        DOWN: { ...scenariosInput.DOWN, volume_delta_pct: parseFloat(e.target.value) || 0 }
                      })}
                    />
                  </div>
                  <div>
                    <label>단가</label>
                    <input
                      type="number"
                      step="0.1"
                      value={scenariosInput.DOWN.price_delta_pct}
                      onChange={(e) => setScenariosInput({
                        ...scenariosInput,
                        DOWN: { ...scenariosInput.DOWN, price_delta_pct: parseFloat(e.target.value) || 0 }
                      })}
                    />
                  </div>
                  <div>
                    <label>변동비</label>
                    <input
                      type="number"
                      step="0.1"
                      value={scenariosInput.DOWN.var_cost_delta_pct}
                      onChange={(e) => setScenariosInput({
                        ...scenariosInput,
                        DOWN: { ...scenariosInput.DOWN, var_cost_delta_pct: parseFloat(e.target.value) || 0 }
                      })}
                    />
                  </div>
                </div>
              </div>
            </div>
            {(validationErrors.UP_v || validationErrors.DOWN_v) && (
              <div className="error-banner">변동률 허용 범위를 초과하였습니다 (판매량: ±50%, 단가/변동비: ±30%).</div>
            )}
          </section>
        )}

        {/* --- S-01 화면: 손익 비교표 --- */}
        {activeTab === 'S-01' && computedResults && (
          <section className="result-section">
            <div className="action-bar">
              <h3>3안 손익 비교 및 시나리오 분석</h3>
              <div className="action-buttons">
                <button className="btn-secondary" onClick={handleCopyClipboard}>클립보드 복사</button>
                <button className="btn-primary" onClick={handleSaveScenarioSet}>가정 세트 저장</button>
              </div>
            </div>

            <div className="table-responsive">
              <table className="comparison-table">
                <thead>
                  <tr>
                    <th>구분 (항목)</th>
                    <th className="col-base">기준안 (BASE)</th>
                    <th>상향안 (UP)</th>
                    <th>하향안 (DOWN)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>판매량 변동률</td>
                    <td className="col-base">0.0%</td>
                    <td>{scenariosInput.UP.volume_delta_pct > 0 ? `+${scenariosInput.UP.volume_delta_pct}` : scenariosInput.UP.volume_delta_pct}%</td>
                    <td>{scenariosInput.DOWN.volume_delta_pct > 0 ? `+${scenariosInput.DOWN.volume_delta_pct}` : scenariosInput.DOWN.volume_delta_pct}%</td>
                  </tr>
                  <tr>
                    <td>단가 변동률</td>
                    <td className="col-base">0.0%</td>
                    <td>{scenariosInput.UP.price_delta_pct > 0 ? `+${scenariosInput.UP.price_delta_pct}` : scenariosInput.UP.price_delta_pct}%</td>
                    <td>{scenariosInput.DOWN.price_delta_pct > 0 ? `+${scenariosInput.DOWN.price_delta_pct}` : scenariosInput.DOWN.price_delta_pct}%</td>
                  </tr>
                  <tr>
                    <td>변동비 변동률</td>
                    <td className="col-base">0.0%</td>
                    <td>{scenariosInput.UP.var_cost_delta_pct > 0 ? `+${scenariosInput.UP.var_cost_delta_pct}` : scenariosInput.UP.var_cost_delta_pct}%</td>
                    <td>{scenariosInput.DOWN.var_cost_delta_pct > 0 ? `+${scenariosInput.DOWN.var_cost_delta_pct}` : scenariosInput.DOWN.var_cost_delta_pct}%</td>
                  </tr>
                  <tr className="highlight-row">
                    <td>판매량 (톤)</td>
                    <td className="col-base">{formatNumber(computedResults[0].V_s, 1)}</td>
                    <td>{formatNumber(computedResults[1].V_s, 1)}</td>
                    <td>{formatNumber(computedResults[2].V_s, 1)}</td>
                  </tr>
                  <tr>
                    <td>적용 판가</td>
                    <td className="col-base">{formatNumber(computedResults[0].P_s, 2)}</td>
                    <td>{formatNumber(computedResults[1].P_s, 2)}</td>
                    <td>{formatNumber(computedResults[2].P_s, 2)}</td>
                  </tr>
                  <tr>
                    <td>적용 단위변동비</td>
                    <td className="col-base">{formatNumber(computedResults[0].C_s, 2)}</td>
                    <td>{formatNumber(computedResults[1].C_s, 2)}</td>
                    <td>{formatNumber(computedResults[2].C_s, 2)}</td>
                  </tr>
                  <tr className="highlight-row">
                    <td>총 매출액 (KRW)</td>
                    <td className="col-base">{formatNumber(computedResults[0].revenue)}</td>
                    <td>{formatNumber(computedResults[1].revenue)}</td>
                    <td>{formatNumber(computedResults[2].revenue)}</td>
                  </tr>
                  <tr>
                    <td>총 변동비 (KRW)</td>
                    <td className="col-base">{formatNumber(computedResults[0].varCost)}</td>
                    <td>{formatNumber(computedResults[1].varCost)}</td>
                    <td>{formatNumber(computedResults[2].varCost)}</td>
                  </tr>
                  <tr className="highlight-row">
                    <td>공헌이익 (KRW)</td>
                    <td className="col-base">{formatNumber(computedResults[0].contrib)}</td>
                    <td>{formatNumber(computedResults[1].contrib)}</td>
                    <td>{formatNumber(computedResults[2].contrib)}</td>
                  </tr>
                  <tr>
                    <td>고정비 (KRW)</td>
                    <td className="col-base">{computedResults[0].hasFixedCost ? formatNumber(computedResults[0].fixedCost) : '고정비 미기재'}</td>
                    <td>{computedResults[1].hasFixedCost ? formatNumber(computedResults[1].fixedCost) : '고정비 미기재'}</td>
                    <td>{computedResults[2].hasFixedCost ? formatNumber(computedResults[2].fixedCost) : '고정비 미기재'}</td>
                  </tr>
                  <tr className="highlight-row">
                    <td>영업이익 (KRW)</td>
                    <td className="col-base">{computedResults[0].hasFixedCost ? formatNumber(computedResults[0].opProfit) : '—'}</td>
                    <td>{computedResults[1].hasFixedCost ? formatNumber(computedResults[1].opProfit) : '—'}</td>
                    <td>{computedResults[2].hasFixedCost ? formatNumber(computedResults[2].opProfit) : '—'}</td>
                  </tr>
                  <tr>
                    <td>영업이익률 (%)</td>
                    <td className="col-base">{computedResults[0].opMargin !== null ? `${computedResults[0].opMargin.toFixed(2)}%` : '—'}</td>
                    <td>{computedResults[1].opMargin !== null ? `${computedResults[1].opMargin.toFixed(2)}%` : '—'}</td>
                    <td>{computedResults[2].opMargin !== null ? `${computedResults[2].opMargin.toFixed(2)}%` : '—'}</td>
                  </tr>
                  <tr>
                    <td>손익분기 판매량 (BEP)</td>
                    <td className="col-base">{formatNumber(computedResults[0].bep, 1)} t</td>
                    <td>{formatNumber(computedResults[1].bep, 1)} t</td>
                    <td>{formatNumber(computedResults[2].bep, 1)} t</td>
                  </tr>
                  {/* 판정 배지 영역 */}
                  <tr className="badge-row">
                    <td>종합 판정</td>
                    <td className="col-base">
                      {!computedResults[0].hasFixedCost ? (
                        <span className="badge-warning">고정비 미기재</span>
                      ) : (
                        <>
                          <span className={`badge-${computedResults[0].marginState === '정상' ? 'normal' : 'danger'}`}>
                            {computedResults[0].marginState}
                          </span>
                          <span className={`badge-${computedResults[0].capState === '정상' ? 'normal' : 'warning'}`}>
                            {computedResults[0].capState}
                          </span>
                          {computedResults[0].bepState !== '—' && (
                            <span className={`badge-${computedResults[0].bepState === '정상' ? 'normal' : 'warning'}`}>
                              {computedResults[0].bepState}
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td>
                      {!computedResults[1].hasFixedCost ? (
                        <span className="badge-warning">고정비 미기재</span>
                      ) : (
                        <>
                          <span className={`badge-${computedResults[1].marginState === '정상' ? 'normal' : 'danger'}`}>
                            {computedResults[1].marginState}
                          </span>
                          <span className={`badge-${computedResults[1].capState === '정상' ? 'normal' : 'warning'}`}>
                            {computedResults[1].capState}
                          </span>
                          {computedResults[1].bepState !== '—' && (
                            <span className={`badge-${computedResults[1].bepState === '정상' ? 'normal' : 'warning'}`}>
                              {computedResults[1].bepState}
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td>
                      {!computedResults[2].hasFixedCost ? (
                        <span className="badge-warning">고정비 미기재</span>
                      ) : (
                        <>
                          <span className={`badge-${computedResults[2].marginState === '정상' ? 'normal' : 'danger'}`}>
                            {computedResults[2].marginState}
                          </span>
                          <span className={`badge-${computedResults[2].capState === '정상' ? 'normal' : 'warning'}`}>
                            {computedResults[2].capState}
                          </span>
                          {computedResults[2].bepState !== '—' && (
                            <span className={`badge-${computedResults[2].bepState === '정상' ? 'normal' : 'warning'}`}>
                              {computedResults[2].bepState}
                            </span>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* --- S-02 화면: 변수별 영향 분석 --- */}
        {activeTab === 'S-02' && sensitivityAnalysis && (
          <section className="sensitivity-section">
            <h3>변수별 영업이익 민감도 분석 (5.8)</h3>
            <p className="section-desc">기준안 대비 각 변수(판매량·단가·변동비)를 단독으로 변화시켰을 때 발생하는 영업이익 증감액과 기여 비중을 나타냅니다.</p>

            <div className="sensitivity-grid">
              {sensitivityAnalysis.map((sa) => (
                <div key={sa.scenario_id} className="sensitivity-card">
                  <h4>{sa.scenario_name} 단독 요인별 영향</h4>
                  <table>
                    <thead>
                      <tr>
                        <th>변수 축</th>
                        <th>변동률</th>
                        <th>영업이익 영향액 (KRW)</th>
                        <th>기여 비중</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sa.items.map((item, idx) => (
                        <tr key={idx}>
                          <td>{item.axis}</td>
                          <td>{item.delta > 0 ? `+${item.delta}%` : `${item.delta}%`}</td>
                          <td className={item.impact >= 0 ? 'text-blue' : 'text-red'}>
                            {item.impact >= 0 ? `+${formatNumber(item.impact)}` : formatNumber(item.impact)}
                          </td>
                          <td>{item.weight.toFixed(1)}%</td>
                        </tr>
                      ))}
                      <tr className="summary-sub-row">
                        <td colSpan={1}>교차 효과 (복합 요인)</td>
                        <td colSpan={3} className={sa.crossEffect >= 0 ? 'text-blue' : 'text-red'}>
                          {sa.crossEffect >= 0 ? `+${formatNumber(sa.crossEffect)}` : formatNumber(sa.crossEffect)}
                        </td>
                      </tr>
                      <tr className="summary-total-row">
                        <td colSpan={2}>총 영업이익 증감</td>
                        <td colSpan={2} className={sa.totalDiff >= 0 ? 'text-blue' : 'text-red'}>
                          {sa.totalDiff >= 0 ? `+${formatNumber(sa.totalDiff)}` : formatNumber(sa.totalDiff)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* --- S-03 화면: 가정 이력 관리 --- */}
        {activeTab === 'S-03' && (
          <section className="history-section">
            <h3>저장된 가정 세트 이력 ({historyList.length})</h3>
            {historyList.length === 0 ? (
              <p className="empty-msg">저장된 가정 세트가 없습니다. 손익 비교 화면에서 [가정 세트 저장]을 실행하세요.</p>
            ) : (
              <div className="history-list">
                {historyList.map((item) => (
                  <div key={item.id} className="history-card" onClick={() => handleRestoreHistory(item)}>
                    <div className="history-header">
                      <span className="history-prod">[{item.productId}] {item.productName}</span>
                      <span className="history-time">{item.time}</span>
                      <button className="btn-delete" onClick={(e) => handleDeleteHistory(e, item.id)}>삭제</button>
                    </div>
                    <div className="history-body">
                      <span>환율: {item.fxRate}</span>
                      <span>상향안 판매량 변동: {item.scenariosInput.UP.volume_delta_pct}%</span>
                      <span>하향안 판매량 변동: {item.scenariosInput.DOWN.volume_delta_pct}%</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* --- S-04 화면: 마스터 반입 (파일 업로드) --- */}
        {activeTab === 'S-04' && (
          <section className="master-upload-section">
            <h3>사업 가정 마스터 파일 반입</h3>
            <p className="section-desc">ERP 또는 엑셀에서 내보낸 JSON 마스터 파일 또는 CSV 파일을 업로드하여 제품군 전체 가정을 교체할 수 있습니다.</p>

            <div className="upload-box">
              <input type="file" accept=".json, .csv" onChange={handleFileUpload} />
              <p className="upload-guide">지원 포맷: JSON (`ds05_product_assumption_master.json` 구조), CSV (UTF-8 인코딩)</p>
            </div>

            <div className="current-master-preview">
              <h4>현재 탑재된 제품 목록 ({masterData.products.length}종)</h4>
              <ul>
                {masterData.products.map(p => (
                  <li key={p.product_id}>
                    <strong>[{p.product_id}] {p.product_name}</strong> ({p.market} / 단가: {p.list_price} {p.currency}) - 목표 이익률: {p.target_op_margin_pct}%
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
