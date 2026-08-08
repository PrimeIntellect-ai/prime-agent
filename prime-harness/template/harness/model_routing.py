#!/usr/bin/env python3
"""Score confined, content-bound child responses using a versioned evalset."""
from __future__ import annotations
import argparse,hashlib,json
from decimal import Decimal,localcontext
from pathlib import Path
from typing import Any
SUPPORTED_TASKS=("sym-sqrt-square-sign","num-expm1-cancellation","conv-fourth-order","inv-zero-momentum","audit-swallowed-mismatch","provenance-task-scope")
def _default_evalset():return Path(__file__).resolve().parents[1]/"checks/evalset/model-routing-v1.json"
def _load_evalset(path=None):
 p=Path(path) if path else _default_evalset();raw=p.read_bytes();data=json.loads(raw);tasks=tuple(x["id"] for x in data["tasks"])
 if set(tasks)!=set(SUPPORTED_TASKS) or len(tasks)!=len(set(tasks)):raise ValueError("evalset task IDs do not exactly match supported scoring oracles")
 roles=data.get("role_weights",{});minimum=data.get("minimum_tasks_per_candidate")
 if type(minimum) is not int or minimum<3 or minimum>len(tasks):raise ValueError("invalid evalset minimum_tasks_per_candidate")
 for role,weights in roles.items():
  if set(weights)-set(tasks) or abs(sum(float(v) for v in weights.values())-1)>1e-12:raise ValueError(f"invalid role weights: {role}")
 return data,tasks,roles,minimum,hashlib.sha256(raw).hexdigest()
def _answer(answers,task):
 if task in answers:return answers[task],True
 target=task.replace("-","_")
 for key,value in answers.items():
  normalized=str(key);normalized=normalized.split("_",1)[1] if normalized[:1].isdigit() and "_" in normalized else normalized
  if normalized==target:return value,False
 return None,False
def _expm1():
 with localcontext() as c:
  c.prec=120;x=Decimal("1e-20");term=x;total=x;n=2
  while term:
   term=term*x/Decimal(n);new=total+term
   if new==total:break
   total=new;n+=1
  return +total
def _numeric(a):
 if not isinstance(a,dict) or not isinstance(a.get("values"),dict):return 0.
 ref=_expm1();scores=[]
 for d in (18,36,72):
  try:o=Decimal(str(a["values"][str(d)]));scores.append(float(abs((o-ref)/ref)<=Decimal(10)**Decimal(-min(d-2,60))))
  except Exception:scores.append(0.)
 return sum(scores)/3
def score_answers(answers):
 out={};a,_=_answer(answers,SUPPORTED_TASKS[0]);out[SUPPORTED_TASKS[0]]=float(isinstance(a,dict) and a.get("verdict")=="equivalent_under_assumptions" and a.get("assumptions")==["x >= 0"])
 a,_=_answer(answers,SUPPORTED_TASKS[1]);out[SUPPORTED_TASKS[1]]=_numeric(a);a,_=_answer(answers,SUPPORTED_TASKS[2])
 try:out[SUPPORTED_TASKS[2]]=float(abs(float(a["observed_order"])-4)<=.03)
 except Exception:out[SUPPORTED_TASKS[2]]=0.
 a,_=_answer(answers,SUPPORTED_TASKS[3])
 try:out[SUPPORTED_TASKS[3]]=float(a.get("conserved") is True and abs(float(a["relative_drift"])-2e-14)<=1e-15)
 except Exception:out[SUPPORTED_TASKS[3]]=0.
 a,_=_answer(answers,SUPPORTED_TASKS[4]);claim=str(a.get("claim","")).casefold() if isinstance(a,dict) else "";out[SUPPORTED_TASKS[4]]=float(isinstance(a,dict) and str(a.get("severity","")).casefold() in {"critical","major"} and any(x in claim for x in ("mismatch","hash","digest")) and any(x in claim for x in ("pass","success","accept")) and bool(a.get("falsification_test")))
 a,_=_answer(answers,SUPPORTED_TASKS[5]);out[SUPPORTED_TASKS[5]]=float(isinstance(a,dict) and a.get("supporting_ids")==["e1"] and a.get("rejected_ids")==["e2"] and "task" in str(a.get("reason","")).casefold());return out
def score_manifest(manifest,evalset_path=None):
 evalset,tasks,roles,minimum,eval_hash=_load_evalset(evalset_path);root=Path(manifest["response_root"]).resolve();candidates=[]
 for item in manifest.get("candidates",[]):
  rel=Path(item["response_path"])
  if rel.is_absolute() or ".." in rel.parts:raise ValueError("response_path must be confined and relative")
  path=(root/rel).resolve()
  try:path.relative_to(root)
  except ValueError:raise ValueError("response_path escapes response_root")
  if path.is_symlink() or not path.is_file():raise ValueError("response_path must be a regular file")
  raw=path.read_bytes();digest=hashlib.sha256(raw).hexdigest()
  if item.get("sha256") and item["sha256"]!=digest:raise ValueError("response sha256 mismatch")
  payload=json.loads(raw);answers=payload.get("evidence",{}).get("answers",{});scores=score_answers(answers);recognized=sum(_answer(answers,t)[0] is not None for t in tasks);exact=sum(t in answers for t in tasks)/len(tasks);overall=sum(scores[t] for t in tasks)/len(tasks);role_scores={role:sum(scores[t]*float(w) for t,w in weights.items()) for role,weights in roles.items()};candidates.append({"selector":item["selector"],"response_path":rel.as_posix(),"response_sha256":digest,"tasks_attempted":recognized,"task_scores":scores,"exact_contract_rate":exact,"overall_score":overall,"role_scores":role_scores})
 candidates.sort(key=lambda x:(-x["overall_score"],-x["exact_contract_rate"],x["selector"]));routes=[]
 for role in roles:
  ranked=sorted(candidates,key=lambda x:(-x["role_scores"][role],-x["overall_score"],-x["exact_contract_rate"],x["selector"]));routes.append({"role":role,"selector":ranked[0]["selector"],"measured_score":ranked[0]["role_scores"][role],"fallbacks":[x["selector"] for x in ranked[1:3]]}) if ranked else None
 status="pass" if candidates and all(x["tasks_attempted"]>=minimum for x in candidates) else "fail";return {"schema_version":1,"status":status,"evalset_sha256":eval_hash,"evalset_tasks":list(tasks),"minimum_tasks_per_candidate":minimum,"candidate_count":len(candidates),"candidates":candidates,"routing_table":routes}
def main(argv=None):
 p=argparse.ArgumentParser();p.add_argument("manifest");p.add_argument("--evalset");p.add_argument("--output",required=True);a=p.parse_args(argv);result=score_manifest(json.loads(Path(a.manifest).read_text()),a.evalset);Path(a.output).parent.mkdir(parents=True,exist_ok=True);Path(a.output).write_text(json.dumps(result,indent=2,sort_keys=True)+"\n");print(json.dumps({"status":result["status"],"output":a.output,"candidates":result["candidate_count"]},sort_keys=True));return 0 if result["status"]=="pass" else 2
if __name__=="__main__":raise SystemExit(main())
