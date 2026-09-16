# Built-in machine profiles

JDM includes 21 ready profiles, named by hook count and starting fabric density. Choose a profile in the editor's **Machine** selector. In **Settings → Machine profiles**, search by hooks or name, expand a profile to edit it, choose a default, or add a custom machine.

The starting density is **96 EPI / 52 PPI**, taken from the user's requested example. These values are editable fabric settings, not fixed properties of a jacquard model. EPI means warp ends per inch and PPI means picks per inch. A reed count is not necessarily EPI; the reed-count convention and the ends drawn through each dent determine the resulting warp density.

JDM's **hooks** value should be the usable design-hook width of the actual setup. A jacquard head's advertised total can include hooks allocated outside the design. The presets do not automatically subtract a reserve or infer a harness arrangement from a brand name.

## Capacity references

Checked 15 September 2026. These first-party product and facility pages document available capacities or installed setups; they do not establish sales rankings or an exhaustive list of all machines on the market.

| Included hooks | First-party reference |
| --- | --- |
| 640, 960, 1344, 1440, 2688 | [Paramount Looms, Surat](https://www.paramountlooms.com/portfolio/jacquard-looms-manufacturer-surat/) |
| 480, 1408 | [TIATECH S-S Series](https://tiatech.co.in/s-s-series/) |
| 1536 | [TIATECH S-C Series](https://tiatech.co.in/s-c-series/) |
| 2048, 2816, 3328, 3840, 4608, 5376 | [TIATECH D-C Series](https://tiatech.co.in/d-c-series/) |
| 1792, 4032 | [Amar electronic handloom jacquards](https://www.amarjacquard.com/handloom-jacquard-machine-manufacturers-exporters-india-1.html) |
| 5120 | [TIATECH Jumbo Jacquards](https://tiatech.co.in/jumbo-jacquard-series/) |
| 6144 | [TIATECH High Speed Jacquards](https://tiatech.co.in/high-speed-jacquard/) |
| 1200, 2400, 4800 installed design-hook setups | [Kuanging weaving facilities](https://www.kuanging.com/facility) |

The catalog intentionally uses capacities rather than claiming that a named loom model has a fixed reed/pick combination. Larger or different setups can be added in Settings.

## Saved workspaces

New workspaces start with the catalog and a **2400 hooks / 96 EPI / 52 PPI** default. Existing workspaces receive missing presets once, while keeping their chosen default, custom profiles, colors and saved designs. Edited presets are preserved; equivalent numeric profiles are not duplicated. After the upgrade, removing an unused preset keeps it removed on restart. **Add missing preset profiles** can restore missing entries without overwriting edits. A workspace supports up to 100 profiles.

For a 10 × 10 inch design at 96 EPI / 52 PPI, the output is **960 × 520 pixels**.
