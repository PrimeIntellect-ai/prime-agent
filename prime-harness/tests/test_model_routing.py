from __future__ import annotations
import importlib.util,json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];SOURCE=ROOT/"template/harness/model_routing.py";SPEC=importlib.util.spec_from_file_location("routing_tested",SOURCE);assert SPEC and SPEC.loader;mod=importlib.util.module_from_spec(SPEC);sys.modules[SPEC.name]=mod;SPEC.loader.exec_module(mod)
def answers():
 return {"sym-sqrt-square-sign":{"verdict":"equivalent_under_assumptions","assumptions":["x >= 0"]},"num-expm1-cancellation":{"values":{"18":"1e-20","36":"1.000000000000000000005e-20","72":"1.00000000000000000000500000000000000000001666666666666666666666666666667e-20"}},"conv-fourth-order":{"observed_order":4},"inv-zero-momentum":{"conserved":True,"relative_drift":2e-14},"audit-swallowed-mismatch":{"severity":"critical","claim":"mismatch returns pass","falsification_test":"mismatch"},"provenance-task-scope":{"supporting_ids":["e1"],"rejected_ids":["e2"],"reason":"task id"}}
def test_perfect_scores_and_routes(tmp_path):
 p=tmp_path/"r.json";p.write_text(json.dumps({"evidence":{"answers":answers()}}));r=mod.score_manifest({"response_root":str(tmp_path),"candidates":[{"selector":"m","response_path":"r.json"}]});assert r["status"]=="pass";assert r["candidates"][0]["overall_score"]==1;assert all(x["selector"]=="m" for x in r["routing_table"])
def test_wrong_numeric_and_prefixed_contract_are_measured(tmp_path):
 a=answers();a["num-expm1-cancellation"]["values"]["36"]="1e-20";a={f"{i}_{k.replace('-','_')}":v for i,(k,v) in enumerate(a.items(),1)};p=tmp_path/"r.json";p.write_text(json.dumps({"evidence":{"answers":a}}));r=mod.score_manifest({"response_root":str(tmp_path),"candidates":[{"selector":"m","response_path":"r.json"}]});c=r["candidates"][0];assert c["task_scores"]["num-expm1-cancellation"]<1;assert c["exact_contract_rate"]==0

def test_empty_and_arbitrary_answers_fail_cleanly(tmp_path):
 p=tmp_path/"r.json";p.write_text(json.dumps({"evidence":{"answers":{"junk":{},"x":{},"y":{}}}}));r=mod.score_manifest({"response_root":str(tmp_path),"candidates":[{"selector":"m","response_path":"r.json"}]});assert r["status"]=="fail";assert r["candidates"][0]["tasks_attempted"]==0;assert mod.score_manifest({"response_root":str(tmp_path),"candidates":[]})["status"]=="fail"
def test_response_paths_are_confined_and_hashed(tmp_path):
 p=tmp_path/"r.json";p.write_text(json.dumps({"evidence":{"answers":answers()}}))
 try:mod.score_manifest({"response_root":str(tmp_path),"candidates":[{"selector":"m","response_path":"../r.json"}]})
 except ValueError as e:assert "confined" in str(e)
 else:assert False
 r=mod.score_manifest({"response_root":str(tmp_path),"candidates":[{"selector":"m","response_path":"r.json"}]});assert r["candidates"][0]["response_sha256"]
