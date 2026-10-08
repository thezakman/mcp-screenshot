import { describe,it,expect } from 'vitest';
import { selectWindow,sameWindow } from '../src/native.js';
import { WINDOW } from './helpers.js';
describe('window identity',()=>{
 it('rejects ambiguous apps and requires a unique window',()=>{
   expect(()=>selectWindow([WINDOW,{...WINDOW,id:43}],{burp:true})).toThrow('AMBIGUOUS_WINDOW');
   expect(selectWindow([WINDOW],{burp:true})).toEqual(WINDOW);
 });
 it('never falls back to another window after the selected one closes',()=>{
   expect(()=>selectWindow([{...WINDOW,id:43}],{window_id:42})).toThrow('WINDOW_NOT_FOUND');
 });
 it('checks PID, title, and bounds as well as ID',()=>{
   expect(sameWindow(WINDOW,{...WINDOW,pid:51})).toBe(false);
   expect(sameWindow(WINDOW,{...WINDOW,title:'different'})).toBe(false);
   expect(sameWindow(WINDOW,{...WINDOW,bounds:{...WINDOW.bounds,width:600}})).toBe(false);
 });
 it('matches exact app names instead of capturing a similarly named app',()=>{
   expect(()=>selectWindow([WINDOW],{app_name:'Burp'})).toThrow('WINDOW_NOT_FOUND');
 });
});
