#!/usr/bin/env python3
"""Deterministically score oracle-isolated child responses into roster routes."""
from __future__ import annotations
import argparse, json, math
from decimal import Decimal, localcontext
from pathlib import Path
from typing import Any

TASKS=("sym-sqrt-square-sign","num-expm1-cancellation","conv-fourth-order","inv-zero-momentum","audit-swallowed-mismatch","provenance-task-scope")
ROLE_WEIGHTS={
 "implementation-engineer":{"audit-swallowed-mismatch":.35,"provenance-task-scope":.20,"sym-sqrt-square-sign":.15,"num-expm1-cancellation":.10,"conv-fourth-order":.10,"inv-zero-momentum":.10},
 "symbolic-auditor":{"sym-sqrt-square-sign":.70,"provenance-task-scope":.30},
 "numerical-auditor":{"num-expm1-cancellation":.40,"conv-fourth-order":.30,"inv-zero-momentum":.30},
 "adversarial-reviewer":{"audit-swallowed-mismatch":.70,"provenance-task-scope":.30},
 "literature-engineer":{"provenance-task-scope":.60,"sym-sqrt-square-sign":.40},
 "experiment-operator":{"conv-fourth-order":.30,"inv-zero-momentum":.30,"num-expm1-cancellation":.20,"provenance-task-scope":.20},
}

def _answer(answers:dict[str,Any],task:str)->tuple[Any,bool]:
 if task in answers:return answers[task],True
 target=task.replace("-","_")
 for key,value in answers.items():
  if str(key).removeprefix("1_").removeprefix("2_").removeprefix("3_").removeprefix("4_").removeprefix("5_").removeprefix("6_")==target:return value,False
 return None,False

def _expm1()->Decimal:
 with localcontext() as ctx:
  ctx.prec=120;x=Decimal("1e-20");term=x;total=x;n=2
  while term:
   term=term*x/Decimal(n);new=total+term
   if new==total:break
   total=new;n+=1
  return +total

def _numeric(value:Any)->float:
 if not isinstance(value,dict) or not isinstance(value.get("values"),dict):return 0.0
 ref=_expm1();scores=[]
 for digits in (18,36,72):
  try: observed=Decimal(str(value["values"][str(digits)]))
  except Exception:scores.append(0.0);continue
  rel=abs((observed-ref)/ref);tol=Decimal(10) ** Decimal(-min(digits-2,60));scores.append(1.0 if rel<=tol else 0.0)
 return sum(scores)/3

def score_answers(answers:dict[str,Any])->dict[str,float]:
 out={}
 a,_=_answer(answers,TASKS[0]);out[TASKS[0]]=float(isinstance(a,dict) and a.get("verdict")=="equivalent_under_assumptions" and a.get("assumptions")==["x >= 0"])
 a,_=_answer(answers,TASKS[1]);out[TASKS[1]]=_numeric(a)
 a,_=_answer(answers,TASKS[2]);
 try:out[TASKS[2]]=float(abs(float(a["observed_order"])-4.0)<=.03)
 except Exception:out[TASKS[2]]=0.0
 a,_=_answer(answers,TASKS[3]);
 try:out[TASKS[3]]=float(a.get("conserved") is True and abs(float(a["relative_drift"])-2e-14)<=1e-15)
 except Exception:out[TASKS[3]]=0.0
 a,_=_answer(answers,TASKS[4]);text=json.dumps(a or {}).casefold();out[TASKS[4]]=float(isinstance(a,dict) and str(a.get("severity","")).casefold() in {"critical","major"} and ("mismatch" in text or "hash" in text) and "pass" in text and bool(a.get("falsification_test")))
 a,_=_answer(answers,TASKS[5]);out[TASKS[5]]=float(isinstance(a,dict) and a.get("supporting_ids")==["e1"] and a.get("rejected_ids")==["e2"] and "task" in str(a.get("reason","")).casefold())
 return out

def score_manifest(manifest:dict[str,Any])->dict[str,Any]:
 candidates=[]
 for item in manifest.get("candidates",[]):
  payload=json.loads(Path(item["response_path"]).read_text(encoding="utf-8"));answers=payload.get("evidence",{}).get("answers",{})
  scores=score_answers(answers);exact=sum(task in answers for task in TASKS)/len(TASKS);overall=sum(scores.values())/len(TASKS)
  roles={role:sum(scores[t]*w for t,w in weights.items()) for role,weights in ROLE_WEIGHTS.items()}
  candidates.append({"selector":item["selector"],"response_path":item["response_path"],"tasks_attempted":len(answers),"task_scores":scores,"exact_contract_rate":exact,"overall_score":overall,"role_scores":roles})
 candidates.sort(key=lambda x:(-x["overall_score"],-x["exact_contract_rate"],x["selector"]))
 routes=[]
 for role in ROLE_WEIGHTS:
  ranked=sorted(candidates,key=lambda x:(-x["role_scores"][role],-x["overall_score"],-x["exact_contract_rate"],x["selector"]))
  routes.append({"role":role,"selector":ranked[0]["selector"],"measured_score":ranked[0]["role_scores"][role],"fallbacks":[x["selector"] for x in ranked[1:3]]})
 return {"schema_version":1,"status":"pass" if candidates and all(x["tasks_attempted"]>=3 for x in candidates) else "fail","evalset_tasks":list(TASKS),"minimum_tasks_per_candidate":3,"candidate_count":len(candidates),"candidates":candidates,"routing_table":routes}

def main(argv=None):
 p=argparse.ArgumentParser();p.add_argument("manifest");p.add_argument("--output",required=True);a=p.parse_args(argv);result=score_manifest(json.loads(Path(a.manifest).read_text(encoding="utf-8")));Path(a.output).parent.mkdir(parents=True,exist_ok=True);Path(a.output).write_text(json.dumps(result,indent=2,sort_keys=True)+"\n",encoding="utf-8");print(json.dumps({"status":result["status"],"output":a.output,"candidates":result["candidate_count"]},sort_keys=True));return 0 if result["status"]=="pass" else 2
if __name__=="__main__":raise SystemExit(main())
