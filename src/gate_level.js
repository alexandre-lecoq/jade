// Copyright (C) 2011-2014 Massachusetts Institute of Technology
// Chris Terman

jade.gate_level = (function() {

    ///////////////////////////////////////////////////////////////////////////////
    //
    //  Interface to gatesim
    //
    //////////////////////////////////////////////////////////////////////////////

    // parse foo(1,2,3) into {type: foo, args: [1,2,3]}
    function parse_source(value) {
        var m = value.match(/(\w+)\s*\((.*?)\)\s*/);
        var args = $.map(m[2].split(','),jade.utils.parse_number);
        return {type: m[1], args: args};
    }

    // list of gate properties expected by gatesim
    var gate_properties = ['tcd', 'tpd', 'tr', 'tf', 'cin', 'size', 'ts', 'th'];

    // build extraction environment, ask diagram to give us flattened netlist
    function gate_netlist(aspect) {
        // extract netlist and convert to form suitable for new cktsim.js
        // use modules in the analog libraries as the leafs
        var mlist = ['ground','jumper','analog:v_source','analog:v_probe'];
        if (jade.model.libraries.gates !== undefined)
            $.each(jade.model.libraries.gates.modules,function (mname,module) { mlist.push(module.get_name()); });

        var netlist = aspect.netlist(mlist, '', {}, []);

        // run through extracted netlist, updating device names, evaluating numeric
        // args and eliminating entries we don't care about
        var revised_netlist = [];
        $.each(netlist,function (index,device) {
            var type = device[0];
            var c = device[1];
            var props = device[2];

            var lib_module = type.split(':');
            if (lib_module[0] == 'gates') {
                // copy over relevant properties, evaluating numeric values
                var revised_props = {name: props.name};
                $.each(gate_properties,function (index,pname) {
                    var v = props[pname];
                    if (v) revised_props[pname] = jade.utils.parse_number(v);
                });

                revised_netlist.push({type: lib_module[1],
                                      connections: c,
                                      properties: revised_props
                                      });
            }
            else if (type == 'analog:v_source')
                revised_netlist.push({type: 'voltage source',
                                      connections: c,
                                      properties: {name: props.name, value: parse_source(props.value)}
                                     });
            else if (type == 'ground')   // ground connection
                revised_netlist.push({type: 'ground',
                                      connections: [c.gnd],
                                      properties: {}
                                     });
            else if (type == 'jumper') {  // jumper connection
                var clist = [];
                $.each(c,function (name,node) { clist.push(node); });
                revised_netlist.push({type: 'connect',
                                      connections: clist,
                                      properties: {}
                                     });
            }
            else if (type == 'analog:v_probe')   // ground connection
                revised_netlist.push({type: 'voltage probe',
                                      connections: c,
                                      properties: {name: props.name, color: props.color, offset: jade.utils.parse_number(props.offset)}
                                     });
        });

        //console.log(JSON.stringify(netlist));
        //jade.netlist.print_netlist(revised_netlist);

        return revised_netlist;
    }

    ///////////////////////////////////////////////////////////////////////////////
    //
    // Gate-level simulation
    //
    //////////////////////////////////////////////////////////////////////////////

    function setup_simulation(diagram) {
        diagram.remove_annotations();

        var tstop_lbl = 'Stop Time (seconds)';

        // use modules in the gates library as the leafs
        var netlist = gate_netlist(diagram.aspect);

        if (find_probes(netlist).length === 0) {
            diagram.message("Transient Analysis: there are no probes in the diagram!");
            return;
        }

        var module = diagram.aspect.module;
        var fields = {};
        fields[tstop_lbl] = jade.build_input('text', 10, module.properties.tran_tstop);

        var content = jade.build_table(fields);

        diagram.dialog('Transient Analysis', content, function() {
            // retrieve parameters, remember for next time
            module.set_property('tran_tstop', fields[tstop_lbl].value);
            var tstop = jade.utils.parse_number_alert(module.properties.tran_tstop);

            if (netlist.length > 0 && tstop !== undefined) {
                // gather a list of nodes that are being probed.  These
                // will be added to the list of nodes checked during the
                // LTE calculations in transient analysis
                var probes = find_probes(netlist);
                var probe_names = {};
                for (var i = probes.length - 1; i >= 0; i -= 1) {
                    probe_names[i] = probes[i][1];
                }

                var progress = jade.progress_report();
                diagram.window('Progress', progress); // display progress bar

                cktsim.transient_analysis(netlist,tstop,probe_names,function(percent_complete,results) {
                    if (results === undefined) {
                        progress[0].update_progress(percent_complete);
                        return progress[0].stop_requested;
                    } else {
                        jade.window_close(progress.win); // all done with progress bar
                        simulation_results(results,diagram,probes);
                        return undefined;
                    }
                });
            }
        });
    }

    // process results of transient analysis
    function simulation_results(results,diagram,probes) {
        var v;

        if (typeof results == 'string') diagram.message("Error during Transient analysis:\n\n" + results);
        else if (results === undefined) diagram.message("Sorry, no results from transient analysis to plot!");
        else {

            // set up plot values for each node with a probe
            var dataseries = [];
            for (var i = probes.length - 1; i >= 0; i -= 1) {
                var color = probes[i][0];
                var label = probes[i][1];
                v = results[label];
                if (v === undefined) {
                    diagram.message('The ' + color + ' probe is connected to node ' + '"' + label + '"' + ' which is not an actual circuit node');
                } else if (color != 'x-axis') {
                    dataseries.push({xvalues: [v.xvalues],
                                     yvalues: [v.yvalues],
                                     name: [label],
                                     color: [color],
                                     xunits: 's',
                                     type: ['digital']
                                    });
                }
            }

            // graph the result and display in a window
            var graph = jade.plot.graph(dataseries);
            diagram.window('Results of Gate-level simulation', graph);
        }
    }

    // add transient analysis to tool bar
    jade.schematic_view.schematic_tools.push(['gate', 'GATE', 'Gate-level simulation', setup_simulation]);

    // t is the time at which we want a value
    // times is a list of timepoints from the simulation
    function interpolate(t, times, values) {
        if (values === undefined) return undefined;

        for (var i = 0; i < times.length; i += 1) {
            if (t < times[i]) {
                // t falls between times[i-1] and times[i]
                // so return value after most recent datapoint
                return values[i-1];
            }
        }
        return undefined;
    }

    ///////////////////////////////////////////////////////////////////////////////
    //
    // Module exports
    //
    //////////////////////////////////////////////////////////////////////////////

    return {
        gate_netlist: gate_netlist,
        interpolate: interpolate
    };

}());