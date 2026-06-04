# Time Dilation Effects

The player does not actually move faster than light - instead, their in-game speed (which can be many times faster than light) is the speed that they appear to be travelling from their own perspective. Traveling a long distance at high velocities causes time to speed up around them. This should impact rotational speeds and, at higher values, planetary evolution. Since all planetary development is derived from a seed and object age and the player cannot create lasting impacts, this allows the player to "travel into the future" through long distance space flight, simply by respawning systems when returning to a solar system. (Travel within a solar system is on the scale of hours or days and can be ignored when evaluating geological or cosmological timescales.)

function timeAccelMultiplier(w: number): number { // w = apparent velocity (celerity), in units of C
    return Math.sqrt(1 + (w / C) ** 2);
}

# Camera Effects

These effects don't track your apparent velocity w — they track the coordinate velocity v, which is capped at c. Photons Doppler-shift and aberrate according to the real v = w/γ, not the celerity you feel. So the geometry saturates almost immediately while w runs off to 1e15.
Working variables (all derived from the u = w/c you already have):
u = w / c
γ = sqrt(1 + u^2)          # same as your time multiplier
β = u / γ                  # = u / sqrt(1+u^2), asymptotes to 1
By u = 10, β = 0.995. By u = 100, β = 0.99995. Everything geometric is essentially pegged by then.
The three effects
All expressed by θ = angle of the camera ray from your forward (motion) direction, since that's what a shader iterates over.
1. Aberration (the dominant look — the "warp tunnel"). A camera ray at apparent angle θ actually samples the true sky at:
cos θ_true = (cos θ − β) / (1 − β·cos θ)
This crams nearly the whole sky into a forward cone. At β=0.99, a ray only 30° off-forward is showing you something that's truly ~150° around — almost behind you. Forward becomes a compressed bright disc; the rear collapses to a small dark patch.
2. Doppler shift (color). For that same ray, the frequency multiplier is:
D = γ·(1 + β·cos θ)        # f_obs = D · f_emit ; λ_obs = λ_emit / D

Forward (θ=0): D = γ(1+β) = √(1+u²)+u ≈ 2u → blueshift, unbounded with speed.
Apparent side (θ=90°): D = γ → still blueshifted (that object is really ahead of you).
Rear (θ=180°): D = γ(1−β) ≈ 1/(2u) → extreme redshift, fades toward zero.

The neutral (D=1) ring sits far back near the rear pole, so at speed essentially the entire field is blueshifted except a tiny rear cap.
3. Beaming / headlight effect (brightness). Surface brightness scales as the Doppler factor to the fourth:
brightness_mult = D^4        # use D^3 if you mean per-band specific intensity
Forward objects blaze (~16u⁴), rear objects dim to nothing.
The key game consequence
Because β saturates near 1 by a few c but D_forward ≈ 2u keeps climbing linearly forever:

Aberration geometry pegs early — the tunnel shape looks the same at w=10c and w=1e9 c.
Color and brightness keep scaling with full w — they become your natural visual speedometer. Forward point shifts blue → violet → out of visible (artistically: blue-white hot core that whites/violets out), rear deepens red → black.

So the shape tells the player "I'm relativistic"; the color/intensity tells them "...and this is how relativistic."
Shader pseudocode
for each camera ray at angle θ from forward:
    cosT_true = (cos(θ) − β) / (1 − β·cos(θ))
    sky_color = sampleSky(cosT_true, ray_azimuth)      # azimuth unchanged
    D = γ · (1 + β·cos(θ))
    out_color   = shiftSpectrum(sky_color, D)          # /D on wavelength
    out_color  *= D^4                                  # beaming
Two notes: azimuthal angle is unaffected (aberration is purely polar about the velocity axis), and since you're ignoring light-travel delay, you correctly drop Terrell rotation — keep only aberration + Doppler + beaming.
