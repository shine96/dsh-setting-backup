/* eslint-disable */
// lib/client.js —— 客户端半边：左侧栏入口「配置备份」+ 主区页面 + 设置页区。
// 入口成对注册：sidebar.panellist（侧栏行）+ main（主区面板），缺一会导致 selectPanel 抛错。
// 所有写操作都走宿主 /plugins/dsh-setting-backup/* 接口，前端只做展示与触发。
window.__ModuleLoader__.load({
  id: 'dsh-setting-backup',
  factory: (require) => {
    var module = { exports: {} };
    var React = require('react');
    var h = React.createElement;

    var API = '/plugins/dsh-setting-backup';
    var RESTART_API = '/plugins/dsh-restart-now/restart';

    var CSS = [
      '.dsbk-root{padding:16px 20px;display:flex;flex-direction:column;gap:16px;font-size:13px}',
      '.dsbk-head{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:600}',
      '.dsbk-badge{font-size:12px;font-weight:500;padding:1px 8px;border-radius:10px;border:1px solid var(--dsw-color-border,#d0d0d0)}',
      '.dsbk-badge.staged{border-color:#d9a300}',
      '.dsbk-badge.installing{border-color:#3b82f6}',
      '.dsbk-badge.installed{border-color:#0f9d9d}',
      '.dsbk-badge.configured,.dsbk-badge.done{border-color:#22a06b}',
      '.dsbk-badge.failed{border-color:#e5484d}',
      '.dsbk-card{border:1px solid var(--dsw-color-border,#e3e3e3);border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}',
      '.dsbk-card h4{margin:0;font-size:13px;font-weight:600}',
      '.dsbk-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.dsbk-muted{opacity:.65}',
      '.dsbk-mono{font-family:var(--dsw-font-mono,monospace);font-size:12px;word-break:break-all}',
      '.dsbk-btn{border:1px solid var(--dsw-color-border,#d0d0d0);border-radius:6px;padding:4px 12px;cursor:pointer;font-size:13px;background:transparent}',
      '.dsbk-btn[disabled]{opacity:.5;cursor:not-allowed}',
      '.dsbk-btn.primary{border-color:#3b82f6}',
      '.dsbk-list{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:2px}',
      '.dsbk-err{font-size:12px;opacity:.8}',
      '.dsbk-warn{font-size:12px;font-weight:500;padding:6px 8px;border:1px solid #d9a300;border-radius:6px}',
      '.dsbk-label{display:flex;align-items:center;gap:6px;cursor:pointer}',
      '.dsbk-glyph{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;font-size:13px}',
    ].join('');

    function styleOnce() {
      if (typeof document === 'undefined') return;
      if (document.getElementById('dsbk-style')) return;
      var el = document.createElement('style');
      el.id = 'dsbk-style';
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    function post(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body || {}),
      }).then(function (r) { return r.json().catch(function () { return { ok: false, reason: 'bad-json' }; }); });
    }

    function getJson(path) {
      return fetch(API + path, { credentials: 'same-origin' }).then(function (r) {
        return r.ok ? r.json() : null;
      });
    }

    function useStatus() {
      var s = React.useState(null);
      var status = s[0];
      var setStatus = s[1];
      var reload = React.useCallback(function () {
        getJson('/status').then(function (j) { if (j) setStatus(j); }).catch(function () {});
      }, []);
      React.useEffect(function () {
        reload();
        var timer = setInterval(reload, 2500);
        return function () { clearInterval(timer); };
      }, [reload]);
      return [status, reload];
    }

    function Badge(props) {
      var state = (props.status && props.status.state && props.status.state.state) || 'idle';
      var label = props.label || state;
      return h('span', { className: 'dsbk-badge ' + state }, label);
    }

    function Row(props) {
      return h('div', { className: 'dsbk-row' }, props.children);
    }

    function Card(props) {
      return h('div', { className: 'dsbk-card' }, h('h4', null, props.title), props.children);
    }

    // —— 概览 ——
    var STATE_TEXT = {
      idle: '没有进行中的恢复任务。',
      staged: '配置包已就位：重启①后会自动开始安装插件。',
      installing: '正在安装插件，请保持页面打开。',
      installed: '插件已装齐，等待提交配置（第②步）。',
      configured: '配置已提交，重启②后生效。',
      done: '已恢复到备份时的工作台。',
      failed: '上次恢复中断，见下方「故障与日志」。',
    };

    function Overview(props) {
      var status = props.status;
      if (!status) return h('div', { className: 'dsbk-muted' }, '正在读取状态…');
      var state = status.state || { state: 'idle' };
      var progress = state.installProgress;
      var results = state.installResults || [];
      return h(Card, { title: '概览' },
        h(Row, null,
          h(Badge, { status: status }),
          h('span', { className: 'dsbk-muted' }, 'profile: ' + (status.profile || '?')),
          h('span', { className: 'dsbk-muted' }, '插件 ' + (status.bundles ? status.bundles.length : 0) + ' 个'),
          h('span', { className: 'dsbk-muted' }, '备份 ' + (status.snapshots ? status.snapshots.length : 0) + ' 份'),
        ),
        h('div', { className: 'dsbk-mono dsbk-muted' }, status.profileDir || ''),
        state.updatedAtLabel ? h('div', { className: 'dsbk-muted' }, '最后更新：' + state.updatedAtLabel) : null,
        state.state === 'staged' ? h('div', null, '配置包已就位。重启 DSH 后本页会自动开始安装，也可以直接点下方「立即开始安装」。') : null,
        state.state === 'installing'
          ? h('div', null, '正在安装插件… ' + (progress ? progress.done + '/' + progress.total : '准备中'))
          : null,
        state.state === 'installing' && results.length
          ? h('ul', { className: 'dsbk-list' }, results.slice(-6).map(function (r, i) {
            return h('li', { key: r.name + i }, (r.ok ? '✓ ' : '✗ ') + r.name + ' @ ' + r.spec);
          }))
          : null,
        state.state === 'installed' ? h('div', null, '插件已装齐，下一步提交配置。') : null,
        state.state === 'configured' ? h('div', null, '配置已提交，重启 DSH 后生效。') : null,
        state.state === 'done' ? h('div', { className: 'dsbk-muted' }, STATE_TEXT.done) : null,
        state.state === 'failed' ? h('div', { className: 'dsbk-err' }, STATE_TEXT.failed) : null,
        state.installError ? h('div', { className: 'dsbk-err' }, '安装错误：' + state.installError) : null,
      );
    }

    // —— 导出 ——
    function ExportPanel(props) {
      var optSensitive = React.useState(false);
      var optSelf = React.useState(false);
      var busy = React.useState(false);
      var result = React.useState(null);
      var saving = React.useState(false);
      var savedNote = React.useState('');

      function run() {
        busy[1](true);
        result[1](null);
        savedNote[1]('');
        post('/export', { includeSensitive: optSensitive[0], includeSelf: optSelf[0] })
          .then(function (j) { result[1](j); })
          .catch(function (e) { result[1]({ ok: false, reason: String(e) }); })
          .then(function () { busy[1](false); props.onChanged && props.onChanged(); });
      }

      // 另存为：先取文件句柄（必须在用户点击的手势内），再下载字节写入。
      // 浏览器不支持保存对话框时退回普通下载，用户在下载流程里选位置。
      function saveAs() {
        var r = result[0];
        if (!r || !r.ok || !r.name) return;
        saving[1](true);
        savedNote[1]('');
        var pickHandle = null;

        function pick() {
          if (typeof window === 'undefined' || typeof window.showSaveFilePicker !== 'function') {
            return Promise.resolve(null);
          }
          return window.showSaveFilePicker({
            suggestedName: r.name,
            types: [{ description: 'ZIP 压缩包', accept: { 'application/zip': ['.zip'] } }],
          }).then(function (handle) {
            pickHandle = handle;
            return null;
          }).catch(function (error) {
            if (error && error.name === 'AbortError') return 'cancelled';
            return null;
          });
        }

        pick().then(function (verdict) {
          if (verdict === 'cancelled') return null;
          return fetch(API + '/download?name=' + encodeURIComponent(r.name), { credentials: 'same-origin' })
            .then(function (resp) {
              if (!resp.ok) throw new Error('下载失败（HTTP ' + resp.status + '）');
              return resp.blob();
            })
            .then(function (blob) {
              if (pickHandle) {
                return pickHandle.createWritable()
                  .then(function (writable) { return writable.write(blob).then(function () { return writable.close(); }); })
                  .then(function () { savedNote[1]('已保存到你选择的位置。'); });
              }
              var url = URL.createObjectURL(blob);
              var a = document.createElement('a');
              a.href = url;
              a.download = r.name;
              document.body.appendChild(a);
              a.click();
              a.remove();
              setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
              savedNote[1]('已开始下载，请在浏览器下载流程中选择位置。');
              return null;
            });
        }).catch(function (error) {
          savedNote[1]('保存失败：' + (error && error.message ? error.message : String(error)));
        }).then(function () {
          saving[1](false);
        });
      }

      var ok = result[0] && result[0].ok;
      return h(Card, { title: '导出' },
        h('div', { className: 'dsbk-muted' }, '把当前配置与已安装插件清单（含版本）打包成一个 zip。'),
        h(Row, null,
          h('label', { className: 'dsbk-label' },
            h('input', { type: 'checkbox', checked: optSensitive[0], onChange: function (e) { optSensitive[1](e.target.checked); } }),
            '包含凭据（含 .credentials.yaml 与 .env，不推荐）',
          ),
        ),
        h(Row, null,
          h('label', { className: 'dsbk-label' },
            h('input', { type: 'checkbox', checked: optSelf[0], onChange: function (e) { optSelf[1](e.target.checked); } }),
            '同时包含本插件包（用于全新环境自举）',
          ),
        ),
        h(Row, null,
          h('button', { className: 'dsbk-btn primary', disabled: busy[0], onClick: run }, busy[0] ? '正在导出…' : '导出 zip'),
          ok ? h('button', { className: 'dsbk-btn', disabled: saving[0], onClick: saveAs }, saving[0] ? '保存中…' : '另存为…') : null,
        ),
        result[0] ? h('div', null,
          ok
            ? h('div', null,
              h('div', null, '已导出 ' + result[0].plugins + ' 个插件、' + result[0].configFiles + ' 个配置文件（' + result[0].bytes + ' 字节）'),
              h('div', { className: 'dsbk-mono dsbk-muted' }, '默认副本：' + result[0].file),
            )
            : h('div', { className: 'dsbk-err' }, '导出失败：' + (result[0].reason || '未知原因')),
        ) : null,
        savedNote[0] ? h('div', { className: 'dsbk-muted' }, savedNote[0]) : null,
      );
    }

    // —— 导入（预检 → 确认覆盖） ——
    function ImportPanel(props) {
      var busy = React.useState(false);
      var previewing = React.useState(false);
      var preview = React.useState(null);
      var report = React.useState(null);
      var allowSensitive = React.useState(false);
      var fileName = React.useState('');
      var base64Ref = React.useRef('');

      function reset() {
        base64Ref.current = '';
        preview[1](null);
        report[1](null);
        allowSensitive[1](false);
      }

      function onPick(e) {
        var file = e.target.files && e.target.files[0];
        if (!file) return;
        reset();
        fileName[1](file.name);
        var reader = new FileReader();
        reader.onload = function () {
          var text = String(reader.result || '');
          base64Ref.current = text.indexOf(',') >= 0 ? text.slice(text.indexOf(',') + 1) : text;
        };
        reader.readAsDataURL(file);
      }

      function runPreview() {
        if (!base64Ref.current) {
          report[1]({ ok: false, reason: '请先选择 zip 文件' });
          return;
        }
        previewing[1](true);
        report[1](null);
        post('/preview', { zipBase64: base64Ref.current })
          .then(function (j) { preview[1](j); })
          .catch(function (e) { preview[1]({ ok: false, reason: String(e) }); })
          .then(function () { previewing[1](false); });
      }

      function runImport() {
        if (!preview[0] || !preview[0].ok) return;
        busy[1](true);
        report[1](null);
        post('/import', { zipBase64: base64Ref.current, allowSensitive: allowSensitive[0] })
          .then(function (j) { report[1](j); })
          .catch(function (e) { report[1]({ ok: false, reason: String(e) }); })
          .then(function () { busy[1](false); props.onChanged && props.onChanged(); });
      }

      var p = preview[0];
      var sensitive = !!(p && p.ok && p.manifest && p.manifest.sensitive);
      var plan = p && p.plan;
      var canImport = !!(p && p.ok) && (!sensitive || allowSensitive[0]);

      return h(Card, { title: '导入（覆盖当前配置）' },
        h('div', { className: 'dsbk-muted' }, '先预检看清将覆盖什么，再确认导入。导入前会自动留一份快照。'),
        h(Row, null,
          h('input', { type: 'file', accept: '.zip', onChange: onPick }),
          h('button', { className: 'dsbk-btn', disabled: previewing[0], onClick: runPreview }, previewing[0] ? '正在预检…' : '预检'),
        ),
        fileName[0] ? h('div', { className: 'dsbk-mono dsbk-muted' }, '已选择：' + fileName[0]) : null,

        p && !p.ok ? h('div', { className: 'dsbk-err' }, '预检失败：' + (p.reason || '未知原因')) : null,

        p && p.ok ? h('div', { className: 'dsbk-card' },
          h('div', null,
            '来源 profile：' + (p.manifest.profile || '?') +
            ' · 导出于 ' + (p.manifest.createdAtLabel || p.manifest.createdAt || '?'),
          ),
          h('div', { className: 'dsbk-muted' }, '包含 ' + p.pluginCount + ' 个插件、' + p.files.length + ' 个配置文件'),
          sensitive
            ? h('div', { className: 'dsbk-warn' }, '⚠ 此包包含凭据（.credentials.yaml / .env）。仅在可信来源时导入。')
            : null,
          sensitive
            ? h('label', { className: 'dsbk-label' },
              h('input', { type: 'checkbox', checked: allowSensitive[0], onChange: function (e) { allowSensitive[1](e.target.checked); } }),
              '我确认这是我自己导出的包，同意连同凭据一起导入',
            )
            : null,
          plan
            ? h('div', null,
              h('div', null, '待安装 ' + plan.missing.length + ' 个 · 版本不符 ' + plan.versionMismatch.length + ' 个 · 本地来源需手工处理 ' + plan.localWarn.length + ' 个'),
              plan.missing.length
                ? h('ul', { className: 'dsbk-list' }, plan.missing.slice(0, 10).map(function (item) {
                  return h('li', { key: item.name }, item.name + ' @ ' + item.version);
                }))
                : null,
              plan.localWarn.length
                ? h('ul', { className: 'dsbk-list' }, plan.localWarn.slice(0, 10).map(function (item) {
                  return h('li', { key: item.name }, item.name + '（' + item.source + '，跨机可能无法自动安装）');
                }))
                : null,
            )
            : null,
          h('div', { className: 'dsbk-muted' }, '将写入的文件：'),
          h('ul', { className: 'dsbk-list' }, p.files.slice(0, 12).map(function (f) {
            return h('li', { key: f.relPath, className: 'dsbk-mono' }, f.relPath + '  (' + f.bytes + 'B)');
          })),
          p.files.length > 12 ? h('div', { className: 'dsbk-muted' }, '…共 ' + p.files.length + ' 个文件') : null,
          h(Row, null,
            h('button', { className: 'dsbk-btn primary', disabled: busy[0] || !canImport, onClick: runImport },
              busy[0] ? '正在导入…' : (sensitive ? '确认覆盖并导入（含凭据）' : '确认覆盖并导入')),
          ),
          h('div', { className: 'dsbk-muted' }, '导入后需重启①进入安装环节，装齐后提交配置并重启②生效。'),
        ) : null,

        report[0] ? (report[0].ok
          ? h('div', null,
            h('div', null, '已进入恢复流程，当前状态：' + (report[0].state && report[0].state.state)),
            h('div', { className: 'dsbk-muted' }, '接下来请重启 DSH 进入安装环节。'),
          )
          : h('div', { className: 'dsbk-err' }, '导入失败：' + (report[0].reason || '未知原因'))) : null,
      );
    }

    // —— 恢复推进（安装 / 提交 / 回退 / 重启） ——
    function RestorePanel(props) {
      var status = props.status;
      var busy = React.useState('');
      var note = React.useState(null);
      var state = (status && status.state && status.state.state) || 'idle';

      function call(path, label) {
        busy[1](label);
        note[1](null);
        post(path, {})
          .then(function (j) { note[1](j); })
          .catch(function (e) { note[1]({ ok: false, reason: String(e) }); })
          .then(function () { busy[1](''); props.onChanged && props.onChanged(); });
      }

      function restart() {
        fetch(RESTART_API, { method: 'POST', credentials: 'same-origin' })
          .then(function (r) { return r.ok; })
          .catch(function () { return false; })
          .then(function (ok) {
            if (!ok) note[1]({ ok: false, reason: '未能自动重启，请手动重启 DSH' });
          });
      }

      var actions = [];
      if (state === 'staged') {
        actions.push(h('button', { key: 'i', className: 'dsbk-btn primary', disabled: !!busy[0], onClick: function () { call('/install', '安装中'); } }, '立即开始安装'));
        actions.push(h('span', { key: 't', className: 'dsbk-muted' }, '重启后会由本页自动触发，无需手动点。'));
      }
      if (state === 'installed') {
        actions.push(h('button', { key: 'c', className: 'dsbk-btn primary', disabled: !!busy[0], onClick: function () { call('/commit', '提交中'); } }, '提交配置'));
        actions.push(h('span', { key: 'h', className: 'dsbk-muted' }, '提交后需重启生效。'));
      }
      if (state === 'configured') {
        actions.push(h('button', { key: 'r', className: 'dsbk-btn primary', onClick: restart }, '重启 DSH 生效'));
      }
      if (state === 'done') {
        actions.push(h('button', { key: 'r', className: 'dsbk-btn', onClick: restart }, '重启 DSH'));
      }
      if (state === 'installing') {
        actions.push(h('span', { key: 'w', className: 'dsbk-muted' }, '安装进行中，完成后会自动进入下一步。'));
      }
      if (state === 'failed') {
        actions.push(h('button', { key: 'retry', className: 'dsbk-btn primary', disabled: !!busy[0], onClick: function () { call('/install', '重试中'); } }, '重试安装'));
        actions.push(h('button', { key: 'rb', className: 'dsbk-btn', disabled: !!busy[0], onClick: function () { call('/rollback', '回退中'); } }, '整单回退'));
      }

      return h(Card, { title: '恢复推进' },
        actions.length ? h(Row, null, actions) : h('div', { className: 'dsbk-muted' }, '当前没有进行中的恢复任务。'),
        note[0] ? h('div', { className: note[0].ok ? '' : 'dsbk-err' },
          note[0].ok ? '已提交，按提示重启即可生效。' : '操作失败：' + (note[0].reason || '未知原因')) : null,
        busy[0] ? h('div', { className: 'dsbk-muted' }, busy[0] + '…') : null,
      );
    }

    // —— 本地备份 ——
    function SnapshotsPanel(props) {
      var status = props.status;
      var snapshots = (status && status.snapshots) || [];
      var busy = React.useState(false);
      function act(path, stamp) {
        busy[1](true);
        post(path, { stamp: stamp })
          .catch(function () {})
          .then(function () { busy[1](false); props.onChanged && props.onChanged(); });
      }
      return h(Card, { title: '本地备份' },
        snapshots.length === 0
          ? h('div', { className: 'dsbk-muted' }, '暂无快照。导入前会自动创建一份。')
          : h('ul', { className: 'dsbk-list' }, snapshots.slice().reverse().map(function (s) {
            return h('li', { key: s.stamp },
              h('span', { className: 'dsbk-mono' }, s.label || s.stamp),
              ' ',
              h('span', { className: 'dsbk-muted' }, (s.files || 0) + ' 个文件'),
              ' ',
              h('button', { className: 'dsbk-btn', disabled: busy[0], onClick: function () { act('/restore-snapshot', s.stamp); } }, '恢复'),
              ' ',
              h('button', { className: 'dsbk-btn', disabled: busy[0], onClick: function () { act('/delete-snapshot', s.stamp); } }, '删除'),
            );
          })),
      );
    }

    // —— 故障 ——
    function TroubleshootPanel(props) {
      var status = props.status;
      var state = (status && status.state) || {};
      var results = state.installResults || [];
      var failed = results.filter(function (r) { return !r.ok; });
      return h(Card, { title: '故障与日志' },
        failed.length === 0
          ? h('div', { className: 'dsbk-muted' }, '没有失败的安装项。')
          : h('ul', { className: 'dsbk-list' }, failed.map(function (r) {
            return h('li', { key: r.name },
              r.name + '（' + r.spec + '）失败，退出码 ' + r.code,
              r.stderr ? h('div', { className: 'dsbk-mono dsbk-err' }, String(r.stderr).slice(0, 300)) : null,
            );
          })),
        state.state === 'failed' ? h('div', { className: 'dsbk-muted' }, '可先重试安装；仍失败则整单回退，配置会回到导入前。') : null,
      );
    }

    function Panel() {
      styleOnce();
      var pair = useStatus();
      var status = pair[0];
      var reload = pair[1];
      var autoStarted = React.useRef(false);

      // 重启①之后自动进入安装环节：状态为 staged 时本页自行触发一次，不需要用户再点。
      React.useEffect(function () {
        if (!status) return;
        var current = (status.state && status.state.state) || '';
        if (current !== 'staged' || autoStarted.current) return;
        autoStarted.current = true;
        post('/install', {})
          .catch(function () {})
          .then(function () { reload(); });
      }, [status, reload]);

      return h('div', { className: 'dsbk-root' },
        h('div', { className: 'dsbk-head' }, '配置备份与恢复', h(Badge, { status: status })),
        h(Overview, { status: status }),
        h(RestorePanel, { status: status, onChanged: reload }),
        h(ExportPanel, { onChanged: reload }),
        h(ImportPanel, { onChanged: reload }),
        h(SnapshotsPanel, { status: status, onChanged: reload }),
        h(TroubleshootPanel, { status: status }),
      );
    }

    function SettingsSection() {
      return h(Panel, null);
    }

    function Glyph() {
      return h('span', { className: 'dsbk-glyph', 'aria-hidden': 'true' }, '备');
    }

    var name = 'dsh-setting-backup';
    module.exports.name = name;
    module.exports.inject = ['slots'];
    module.exports.apply = function (ctx) {
      var slots = ctx.get('slots');
      if (!slots || typeof slots.inject !== 'function') return;
      slots.inject('sidebar.panellist', function () {
        return slots.register(
          { name: 'sidebar.panellist', id: 'dsh-setting-backup', order: 70, label: '配置备份' },
          Glyph,
        );
      });
      slots.inject('main', function () {
        return slots.register({ name: 'main', key: 'dsh-setting-backup' }, Panel);
      });
      slots.inject('settings.section', function () {
        return slots.register(
          { name: 'settings.section', id: 'dsh-setting-backup', order: 905, label: '配置备份' },
          SettingsSection,
        );
      });
    };
    return module.exports;
  },
});
